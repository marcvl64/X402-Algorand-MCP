/**
 * Human-readable rendering of an Algorand payment transaction.
 *
 * Every signing request carries both the raw bytes and a plain-language
 * description of what signing them authorizes. Signers that put a human in the
 * loop render this description for approval, so it is the last line of defence
 * before someone spends money — and it is assembled partly from strings the
 * merchant controls.
 *
 * Two rules follow, and both are load-bearing:
 *
 * 1. Every authoritative fact is read from the *decoded transaction*, never from
 *    the merchant's 402 challenge. The transaction is what actually gets signed;
 *    the challenge is only a claim about it.
 * 2. Merchant-supplied text is sanitised and quoted before it appears. Without
 *    that, a newline in a `description` field lets a merchant forge extra lines
 *    and misrepresent the amount to the person approving.
 */

import { TransactionType, type Transaction } from '@algorandfoundation/algokit-utils/transact';
import type { PaymentRequirements, ResourceInfo } from '@x402/core/types';

const TESTNET_GENESIS_HASH = 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9';
const MAINNET_GENESIS_HASH = 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8';

/** Longest merchant-supplied string echoed into a description. */
const UNTRUSTED_FIELD_LIMIT = 120;

export function compactAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;
}

export function formatNetwork(network: string | undefined): string {
  if (!network) return 'Algorand';
  if (network.includes(TESTNET_GENESIS_HASH)) return 'Algorand TestNet';
  if (network.includes(MAINNET_GENESIS_HASH)) return 'Algorand MainNet';
  return network.startsWith('algorand:') ? 'Algorand' : network;
}

/**
 * Renders merchant-controlled text so it cannot impersonate the structure of
 * the description. Strips anything that could start a new line or field, caps
 * the length, and wraps the result in quotes so its extent is unambiguous.
 */
export function sanitizeUntrusted(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  // Disallowed characters become spaces rather than vanishing: deleting them
  // would silently join words ("Coffee\nPayment" → "CoffeePayment"), which is
  // its own kind of misleading. Runs of whitespace collapse afterwards.
  const cleaned = Array.from(value.normalize('NFC'))
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      // C0/C1 control characters, including \n and \r.
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return ' ';
      // Unicode line/paragraph separators, and bidi controls that can visually
      // reorder text in a wallet's renderer.
      if (code === 0x2028 || code === 0x2029) return ' ';
      if (code >= 0x202a && code <= 0x202e) return ' ';
      if (code >= 0x2066 && code <= 0x2069) return ' ';
      return ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .trim();

  if (cleaned.length === 0) return undefined;
  const truncated =
    cleaned.length > UNTRUSTED_FIELD_LIMIT
      ? `${cleaned.slice(0, UNTRUSTED_FIELD_LIMIT)}…`
      : cleaned;
  return `"${truncated}"`;
}

function formatAmount(amount: bigint | undefined): string {
  return amount === undefined ? 'unknown amount' : amount.toString();
}

export function summarizeTransaction(txn: Transaction): string {
  if (txn.type === TransactionType.AssetTransfer && txn.assetTransfer) {
    const xfer = txn.assetTransfer;
    return [
      'ASA transfer',
      `asset ${xfer.assetId.toString()}`,
      `amount ${formatAmount(xfer.amount)}`,
      `to ${compactAddress(xfer.receiver.toString())}`,
    ].join(' · ');
  }

  if (txn.type === TransactionType.Payment && txn.payment) {
    const payment = txn.payment;
    return [
      'ALGO payment',
      `${formatAmount(payment.amount)} microAlgos`,
      `to ${compactAddress(payment.receiver.toString())}`,
    ].join(' · ');
  }

  return `Algorand ${txn.type} transaction`;
}

/** What the transaction actually moves, as opposed to what was quoted. */
export interface TransactionFacts {
  readonly asset?: string;
  readonly amount?: bigint;
  readonly receiver?: string;
}

export function transactionFacts(txn: Transaction): TransactionFacts {
  if (txn.type === TransactionType.AssetTransfer && txn.assetTransfer) {
    return {
      asset: txn.assetTransfer.assetId.toString(),
      amount: txn.assetTransfer.amount,
      receiver: txn.assetTransfer.receiver.toString(),
    };
  }
  if (txn.type === TransactionType.Payment && txn.payment) {
    return {
      asset: 'ALGO',
      amount: txn.payment.amount,
      receiver: txn.payment.receiver.toString(),
    };
  }
  return {};
}

/**
 * Builds the description attached to a signing request.
 *
 * Amount, asset and recipient come from `txn` — the bytes being signed. The
 * merchant's own words appear only as a clearly-quoted trailer.
 */
export function buildSigningDescription(args: {
  readonly txn: Transaction;
  readonly txnIndex: number;
  readonly groupSize: number;
  readonly signerAddress: string;
  readonly requirements?: PaymentRequirements;
  readonly resource?: ResourceInfo;
}): string {
  const facts = transactionFacts(args.txn);
  const network = formatNetwork(args.requirements?.network);

  const authoritative = [
    'Approve an x402 payment.',
    facts.amount !== undefined && facts.asset !== undefined && facts.receiver !== undefined
      ? `Paying ${facts.amount} of asset ${facts.asset} to ${compactAddress(facts.receiver)}.`
      : 'Paying: see transaction detail below.',
    `Network: ${network}.`,
    `Sign transaction ${args.txnIndex + 1} of ${args.groupSize} as ${compactAddress(args.signerAddress)}.`,
    summarizeTransaction(args.txn),
    `Sender: ${compactAddress(args.txn.sender.toString())}.`,
  ];

  // Everything below this line is supplied by the merchant and is not verified.
  const name = sanitizeUntrusted(args.resource?.serviceName ?? args.resource?.description);
  const url = sanitizeUntrusted(args.resource?.url);
  const untrusted = [
    name ? `Merchant states this is for: ${name}` : undefined,
    url ? `Merchant states the resource URL is: ${url}` : undefined,
  ].filter(Boolean);

  if (untrusted.length === 0) return authoritative.join('\n');
  return [...authoritative, '--- unverified merchant text ---', ...untrusted].join('\n');
}
