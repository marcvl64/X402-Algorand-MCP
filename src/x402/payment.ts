/**
 * The paid-request flow, split across two MCP tool calls.
 *
 * `prepare` fetches the resource, and on a 402 builds the Algorand transaction
 * group the payment requires — then stops, returning the bytes that need
 * signing. `submit` feeds signatures back in and lets the request complete.
 *
 * The split exists because this server holds no keys. What sits on the other
 * side of it — an AC2-paired wallet, a wallet MCP, a local keypair — is not
 * this module's concern; it only needs raw Ed25519 signatures back.
 *
 * The HTTP mechanics (v2's `PAYMENT-SIGNATURE` request header vs v1's
 * `X-PAYMENT`, and challenges delivered by header rather than body) are left to
 * `wrapFetchWithPayment`. This module only decides *what* to pay and suspends
 * the flow at the point of signing.
 */

import { randomUUID } from 'node:crypto';

import { ExactAvmScheme } from '@x402/avm/exact/client';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import type { Network, PaymentRequirements } from '@x402/core/types';

import type { Config } from '../config.js';
import {
  DeferredSigner,
  PendingPaymentStore,
  type PaymentContext,
  type SigningRequest,
  type SubmittedSignature,
} from './pending.js';
import { isAlgorandCaip2, toPriceSummary, type PriceSummary } from '../discovery.js';
import { readBodyCapped } from '../security/safe-fetch.js';

export class PaymentPolicyError extends Error {
  readonly code = 'payment_policy_violation' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PaymentPolicyError';
  }
}

export class NoAlgorandOptionError extends Error {
  readonly code = 'no_algorand_payment_option' as const;
  constructor(offered: readonly string[]) {
    super(
      `Endpoint offers no Algorand payment option. Networks offered: ${
        offered.length > 0 ? offered.join(', ') : 'none'
      }.`,
    );
    this.name = 'NoAlgorandOptionError';
  }
}

/**
 * Raised when the caller pinned a network the endpoint does not accept. Kept
 * distinct from falling back silently: paying on a different chain than the one
 * asked for is never a safe assumption.
 */
export class NetworkUnavailableError extends Error {
  readonly code = 'requested_network_unavailable' as const;
  constructor(requested: string, offered: readonly string[]) {
    super(
      `Endpoint does not accept payment on ${requested}. It accepts: ${
        offered.length > 0 ? offered.join(', ') : 'no Algorand network'
      }.`,
    );
    this.name = 'NetworkUnavailableError';
  }
}

/**
 * Server-side spend guardrails, applied before any signing request is emitted.
 *
 * These bound what the server will ever ask to be signed. They are a backstop,
 * not the primary control: the signer enforces its own policy and is the only
 * party that can actually authorize a spend.
 */
function enforcePolicy(config: Config, requirements: PaymentRequirements): void {
  let amount: bigint;
  try {
    amount = BigInt(requirements.amount);
  } catch {
    throw new PaymentPolicyError(`Endpoint quoted a non-integer amount: ${requirements.amount}`);
  }

  if (amount > config.maxAmountAtomic) {
    throw new PaymentPolicyError(
      `Endpoint asks ${amount} atomic units of asset ${requirements.asset}, above the server ` +
        `limit of ${config.maxAmountAtomic}. Raise X402_MAX_AMOUNT_ATOMIC to allow it.`,
    );
  }

  if (config.allowedAssets.size > 0 && !config.allowedAssets.has(requirements.asset)) {
    throw new PaymentPolicyError(
      `Endpoint asks for asset ${requirements.asset}, which is not in X402_ALLOWED_ASSETS.`,
    );
  }
}

export interface PreparedPayment {
  readonly status: 'payment_required';
  readonly payment_id: string;
  readonly url: string;
  readonly selected: PriceSummary;
  readonly signing_requests: readonly SigningRequest[];
  readonly expires_in_ms: number;
}

export interface CompletedRequest {
  readonly status: 'ok' | 'http_error';
  readonly url: string;
  readonly http: {
    readonly status: number;
    readonly ok: boolean;
    readonly status_text: string;
    readonly content_type?: string;
  };
  readonly paid: boolean;
  readonly body_text?: string;
  readonly body_json?: unknown;
}

const RESPONSE_BODY_LIMIT_BYTES = 128 * 1024;

async function describeResponse(
  url: string,
  response: Response,
  paid: boolean,
): Promise<CompletedRequest> {
  const contentType = response.headers.get('content-type');
  // Capped read: `response.text()` would buffer the whole body first, so a
  // hostile endpoint streaming gigabytes could exhaust memory before any limit
  // took effect.
  const text = await readBodyCapped(response, RESPONSE_BODY_LIMIT_BYTES);

  let body: Pick<CompletedRequest, 'body_text' | 'body_json'> = { body_text: text };
  if (contentType?.includes('application/json')) {
    try {
      body = { body_json: JSON.parse(text) };
    } catch {
      // Mislabelled JSON — keep the raw text.
    }
  }

  return {
    status: response.ok ? 'ok' : 'http_error',
    url,
    http: {
      status: response.status,
      ok: response.ok,
      status_text: response.statusText,
      ...(contentType !== null ? { content_type: contentType } : {}),
    },
    paid,
    ...body,
  };
}

export interface RequestSpec {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly payerAddress: string;
  /**
   * Pin the payment to one Algorand network. Unlike the configured default —
   * which is only a preference and falls back to whatever the endpoint offers —
   * this is a hard requirement and fails if unavailable.
   */
  readonly network?: string;
}

export const ALGORAND_MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
export const ALGORAND_TESTNET_CAIP2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';

/** Public AlgoNode endpoints, used unless the operator overrides ALGOD_URL. */
const ALGOD_DEFAULTS: Record<string, string> = {
  [ALGORAND_MAINNET_CAIP2]: 'https://mainnet-api.algonode.cloud',
  [ALGORAND_TESTNET_CAIP2]: 'https://testnet-api.algonode.cloud',
};

/** Networks a caller may pin on a per-request basis. */
export const SUPPORTED_NETWORKS = [ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2] as const;

export class PaymentService {
  constructor(
    private readonly config: Config,
    private readonly pending: PendingPaymentStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * The 402 challenge is only seen after the request goes out, but schemes must
   * be registered before it. So every Algorand network this server can pay on
   * is registered up front; the selector then picks among whatever the endpoint
   * actually offers.
   */
  private algodFor(network: string): { algodUrl: string; algodToken: string } {
    const url =
      network === this.config.defaultNetwork
        ? this.config.algodUrl
        : (ALGOD_DEFAULTS[network] ?? this.config.algodUrl);
    return { algodUrl: url, algodToken: this.config.algodToken };
  }

  /**
   * Calls the endpoint. Returns the resource directly when it is free or
   * already accessible; on a 402 returns the bytes that need signing.
   */
  async prepare(spec: RequestSpec): Promise<PreparedPayment | CompletedRequest> {
    const init: RequestInit = {
      method: spec.method ?? 'GET',
      ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
      ...(spec.body !== undefined ? { body: spec.body } : {}),
    };

    let selected: PaymentRequirements | undefined;
    const signer = new DeferredSigner(spec.payerAddress, (): PaymentContext =>
      selected !== undefined ? { requirements: selected } : {},
    );

    const networks = [
      ...(spec.network !== undefined ? [spec.network] : []),
      this.config.defaultNetwork,
      ...Object.keys(ALGOD_DEFAULTS),
    ];
    const client = x402Client.fromConfig({
      schemes: [...new Set(networks)].map((network) => ({
        // CAIP-2 identifiers always contain a colon, satisfying `Network`.
        network: network as Network,
        client: new ExactAvmScheme(signer, this.algodFor(network)),
      })),
      // Runs once the 402 is parsed, before the scheme builds anything. This is
      // where the payment option is chosen and vetted.
      paymentRequirementsSelector: (_version, accepts) => {
        const algorand = accepts.filter((a) => isAlgorandCaip2(a.network));
        if (algorand.length === 0) {
          throw new NoAlgorandOptionError(accepts.map((a) => a.network));
        }

        let chosen: PaymentRequirements;
        if (spec.network !== undefined) {
          // Explicitly pinned: never silently pay on a different network.
          const match = algorand.find((a) => a.network === spec.network);
          if (!match) {
            throw new NetworkUnavailableError(
              spec.network,
              algorand.map((a) => a.network),
            );
          }
          chosen = match;
        } else {
          chosen = algorand.find((a) => a.network === this.config.defaultNetwork) ?? algorand[0]!;
        }

        enforcePolicy(this.config, chosen);
        selected = chosen;
        return chosen;
      },
    });

    const paidFetch = wrapFetchWithPayment(this.fetchImpl, client);
    const paymentId = randomUUID();

    // Kick off the request. If it needs paying it will suspend inside the
    // signer and only resume once `submit` supplies signatures.
    const result = paidFetch(spec.url, init);

    // Never leave an unhandled rejection behind if `submit` is never called.
    result.catch(() => undefined);

    const outcome = await Promise.race([
      signer.whenRequestsReady().then((requests) => ({ kind: 'signing' as const, requests })),
      result.then((response) => ({ kind: 'done' as const, response })),
    ]);

    if (outcome.kind === 'done') {
      // No payment was needed — free endpoint, cached access, or an error.
      return describeResponse(spec.url, outcome.response, false);
    }

    this.pending.add({
      id: paymentId,
      url: spec.url,
      signer,
      requests: outcome.requests,
      result,
    });

    return {
      status: 'payment_required',
      payment_id: paymentId,
      url: spec.url,
      selected: toPriceSummary(selected!),
      signing_requests: outcome.requests,
      expires_in_ms: this.config.pendingTtlMs,
    };
  }

  /** Feeds signatures back into a prepared payment and returns the resource. */
  async submit(
    paymentId: string,
    signatures: readonly SubmittedSignature[],
  ): Promise<CompletedRequest> {
    const payment = this.pending.take(paymentId);
    if (!payment) {
      throw new Error(
        `Unknown or expired payment_id: ${paymentId}. Prepared payments are short-lived ` +
          '(Algorand transactions have a narrow validity window); call prepare_payment again.',
      );
    }

    payment.signer.settle(signatures);
    return describeResponse(payment.url, await payment.result, true);
  }
}
