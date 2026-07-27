/**
 * Deferred signing bridge.
 *
 * The x402 AVM scheme builds a transaction group and hands it to a
 * `ClientAvmSigner` synchronously inside `createPaymentPayload`. This server
 * holds no keys, so instead of signing it parks the in-flight payment: it
 * surfaces the unsigned transactions to the caller as signing requests, then
 * suspends until signatures are handed back through `settle()`.
 *
 * The signer on the other end is deliberately unspecified. An AC2-paired wallet,
 * a wallet MCP, or a local keypair all satisfy the same contract: receive bytes
 * plus a description, return a raw 64-byte Ed25519 signature.
 *
 * Transactions cannot simply be rebuilt on the second call — they carry
 * validity rounds and a group ID fixed at build time — so the flow must stay
 * suspended rather than restart.
 */

import {
  bytesForSigning,
  decodeTransaction,
  encodeSignedTransaction,
  type Transaction,
} from '@algorandfoundation/algokit-utils/transact';
import type { PaymentRequirements, ResourceInfo } from '@x402/core/types';
import type { ClientAvmSigner } from '@x402/avm';

import { buildSigningDescription, transactionFacts } from './summary.js';

/** Schema identifier for the payload carried in a signing request. */
export const ALGORAND_SIGNING_SCHEMA = 'x402/exact/algorand/v2/transaction-signing-bytes';

export interface SigningRequest {
  /** Index within the transaction group. Echo this back in the signature. */
  readonly index: number;
  /** Raw bytes to sign, base64. Sign these directly with Ed25519. */
  readonly payload_base64: string;
  /** Plain-language description of what signing authorizes. */
  readonly description: string;
  /** Address expected to have produced the signature. */
  readonly signer_address: string;
  readonly schema: string;
  readonly sig_hint: 'raw-ed25519';
}

export interface SubmittedSignature {
  readonly index: number;
  /** Raw 64-byte Ed25519 signature, base64. */
  readonly signature_base64: string;
}

export class SigningRejectedError extends Error {
  readonly code = 'signing_rejected' as const;
  constructor(reason: string) {
    super(`x402 payment signing rejected: ${reason}`);
    this.name = 'SigningRejectedError';
  }
}

/**
 * Raised when the transaction that was built does not move what the endpoint
 * quoted. Policy is enforced against the quote, so a transaction that diverges
 * from it has escaped those limits and must never reach a signer.
 */
export class QuoteMismatchError extends Error {
  readonly code = 'quote_mismatch' as const;
  constructor(field: string, quoted: string, actual: string) {
    super(
      `Built transaction does not match the quoted payment: ${field} was quoted as ${quoted} ` +
        `but the transaction specifies ${actual}. Refusing to request a signature.`,
    );
    this.name = 'QuoteMismatchError';
  }
}

export class PaymentExpiredError extends Error {
  readonly code = 'payment_expired' as const;
  constructor(paymentId: string) {
    super(
      `Prepared payment ${paymentId} expired before signatures were submitted. ` +
        'Transaction validity windows are short — call prepare_payment again.',
    );
    this.name = 'PaymentExpiredError';
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decodeSignature(value: string, index: number): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (bytes.length !== 64) {
    throw new Error(
      `Signature for transaction ${index + 1} is ${bytes.length} bytes; ` +
        'expected a raw 64-byte Ed25519 signature (not a signed transaction).',
    );
  }
  return bytes;
}

function indexesFor(indexesToSign: number[] | undefined, groupSize: number): Set<number> {
  if (indexesToSign === undefined) {
    return new Set(Array.from({ length: groupSize }, (_v, i) => i));
  }
  return new Set(indexesToSign);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface PaymentContext {
  readonly requirements?: PaymentRequirements;
  readonly resource?: ResourceInfo;
}

/**
 * Cross-checks the built transaction against the quote that policy was applied
 * to. Spend limits are enforced against the quote in the requirements selector;
 * if the transaction moves something else, those limits mean nothing.
 *
 * Only the payer's own outgoing transfer is checked — a group may also contain
 * a fee-payer transaction signed by the facilitator, which moves nothing on the
 * payer's behalf.
 */
export function assertMatchesQuote(
  txn: Transaction,
  requirements: PaymentRequirements | undefined,
): void {
  if (!requirements) return;
  const facts = transactionFacts(txn);
  if (facts.amount === undefined) return; // not a value transfer

  if (facts.asset !== undefined && facts.asset !== requirements.asset) {
    throw new QuoteMismatchError('asset', requirements.asset, facts.asset);
  }
  if (facts.receiver !== undefined && facts.receiver !== requirements.payTo) {
    throw new QuoteMismatchError('recipient', requirements.payTo, facts.receiver);
  }

  let quoted: bigint;
  try {
    quoted = BigInt(requirements.amount);
  } catch {
    throw new QuoteMismatchError('amount', requirements.amount, facts.amount.toString());
  }
  if (facts.amount > quoted) {
    throw new QuoteMismatchError('amount', quoted.toString(), facts.amount.toString());
  }
}

/**
 * A `ClientAvmSigner` that never signs. It publishes the signing requests it is
 * asked for and waits for an external signer to supply the signatures.
 */
export class DeferredSigner implements ClientAvmSigner {
  private readonly requestsReady = deferred<readonly SigningRequest[]>();
  private readonly signatures = deferred<readonly SubmittedSignature[]>();
  private decodedTxns: { index: number; txn: Transaction }[] = [];

  constructor(
    readonly address: string,
    private readonly getContext: () => PaymentContext,
  ) {
    // `abort()` rejects both promises, but whether anything is awaiting them
    // depends on how far the flow got. Attach inert handlers so an abort before
    // the flow reaches the signer cannot surface as an unhandled rejection —
    // which Node treats as fatal. Real awaiters still see the rejection.
    this.requestsReady.promise.catch(() => undefined);
    this.signatures.promise.catch(() => undefined);
  }

  /** Resolves once the payment flow has produced a transaction group to sign. */
  whenRequestsReady(): Promise<readonly SigningRequest[]> {
    return this.requestsReady.promise;
  }

  /** Hands signatures to the suspended flow, letting it complete. */
  settle(signatures: readonly SubmittedSignature[]): void {
    this.signatures.resolve(signatures);
  }

  /** Aborts the suspended flow. */
  abort(err: unknown): void {
    this.requestsReady.reject(err);
    this.signatures.reject(err);
  }

  async signTransactions(
    txns: Uint8Array[],
    indexesToSign?: number[],
  ): Promise<(Uint8Array | null)[]> {
    const wanted = indexesFor(indexesToSign, txns.length);
    const requests: SigningRequest[] = [];
    this.decodedTxns = [];

    for (let i = 0; i < txns.length; i++) {
      if (!wanted.has(i)) continue;

      const raw = txns[i];
      if (!raw) throw new Error(`Missing Algorand transaction at index ${i}.`);

      let txn: Transaction;
      try {
        txn = decodeTransaction(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Unable to decode Algorand transaction at index ${i}: ${msg}`);
      }

      const sender = txn.sender.toString();
      if (sender !== this.address) {
        throw new Error(
          `Transaction ${i + 1} has sender ${sender}, but the payer address is ${this.address}.`,
        );
      }

      const context = this.getContext();
      assertMatchesQuote(txn, context.requirements);
      this.decodedTxns.push({ index: i, txn });
      requests.push({
        index: i,
        payload_base64: base64(bytesForSigning.transaction(txn)),
        description: buildSigningDescription({
          txn,
          txnIndex: i,
          groupSize: txns.length,
          signerAddress: this.address,
          ...(context.requirements !== undefined ? { requirements: context.requirements } : {}),
          ...(context.resource !== undefined ? { resource: context.resource } : {}),
        }),
        signer_address: this.address,
        schema: ALGORAND_SIGNING_SCHEMA,
        sig_hint: 'raw-ed25519',
      });
    }

    this.requestsReady.resolve(requests);

    // Suspend here until an external signer supplies signatures.
    const supplied = await this.signatures.promise;
    const byIndex = new Map(supplied.map((s) => [s.index, s.signature_base64]));

    const signed: (Uint8Array | null)[] = new Array(txns.length).fill(null);
    for (const { index, txn } of this.decodedTxns) {
      const value = byIndex.get(index);
      if (value === undefined) {
        throw new Error(`No signature supplied for transaction at index ${index}.`);
      }
      signed[index] = encodeSignedTransaction({ txn, sig: decodeSignature(value, index) });
    }
    return signed;
  }
}

export interface PendingPayment {
  readonly id: string;
  readonly url: string;
  readonly signer: DeferredSigner;
  readonly requests: readonly SigningRequest[];
  /** Resolves with the resource response once signatures are submitted. */
  readonly result: Promise<Response>;
}

/**
 * TTL-bounded registry of payments awaiting signatures.
 *
 * This is the server's only mutable state, and it is short-lived by design:
 * Algorand transaction validity windows mean an unsigned group is worthless
 * within a few minutes.
 */
export class TooManyPendingPaymentsError extends Error {
  readonly code = 'too_many_pending_payments' as const;
  constructor(limit: number) {
    super(
      `This session already has ${limit} payments awaiting signature. ` +
        'Submit or abandon one before preparing another.',
    );
    this.name = 'TooManyPendingPaymentsError';
  }
}

export class PendingPaymentStore {
  private readonly entries = new Map<string, { payment: PendingPayment; timer: NodeJS.Timeout }>();

  constructor(
    private readonly ttlMs: number,
    /**
     * Each parked payment holds an open upstream connection, so an uncapped
     * store lets a caller exhaust sockets and memory just by repeating
     * prepare_payment.
     */
    private readonly maxEntries = 16,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  add(payment: PendingPayment): void {
    if (this.entries.size >= this.maxEntries) {
      throw new TooManyPendingPaymentsError(this.maxEntries);
    }
    const timer = setTimeout(() => {
      this.entries.delete(payment.id);
      payment.signer.abort(new PaymentExpiredError(payment.id));
    }, this.ttlMs);
    // Do not hold the event loop open purely to expire a pending payment.
    timer.unref?.();
    this.entries.set(payment.id, { payment, timer });
  }

  take(id: string): PendingPayment | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    return entry.payment;
  }

  /** Aborts everything still waiting. Used on shutdown. */
  clear(reason: string): void {
    for (const { payment, timer } of this.entries.values()) {
      clearTimeout(timer);
      payment.signer.abort(new SigningRejectedError(reason));
    }
    this.entries.clear();
  }
}
