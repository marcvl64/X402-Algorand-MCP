/**
 * Human-readable rendering of an Algorand payment transaction.
 *
 * Every signing request this server emits carries both the raw bytes and a
 * plain-language description of what signing them actually authorizes. Signers
 * that put a human in the loop (an AC2-paired wallet, a wallet MCP with a
 * confirmation prompt) render this description for approval; fully autonomous
 * signers can use it for logging and policy checks. Either way the server is
 * agnostic about which signer is on the other end.
 */

import { TransactionType, type Transaction } from '@algorandfoundation/algokit-utils/transact';
import type { PaymentRequirements, ResourceInfo } from '@x402/core/types';

const TESTNET_GENESIS_HASH = 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9';
const MAINNET_GENESIS_HASH = 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8';

export function compactAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;
}

export function formatNetwork(network: string | undefined): string {
  if (!network) return 'Algorand';
  if (network.includes(TESTNET_GENESIS_HASH)) return 'Algorand TestNet';
  if (network.includes(MAINNET_GENESIS_HASH)) return 'Algorand MainNet';
  return network.startsWith('algorand:') ? 'Algorand' : network;
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

function resourceName(resource?: ResourceInfo): string {
  const name = resource?.description ?? resource?.serviceName;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'paid resource';
}

function resourceDetails(resource?: ResourceInfo): string {
  if (!resource) return '';
  const parts = [resource.url, resource.mimeType].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  return parts.length > 0 ? `Resource: ${parts.join(' · ')}` : '';
}

/**
 * Builds the human-readable description attached to a signing request. It must
 * fully describe what approving actually pays for, since for human-in-the-loop
 * signers this is the only thing the user reads before approving. Maps directly
 * onto an `ac2/SigningRequest` `description` field, but carries no AC2
 * dependency.
 */
export function buildSigningDescription(args: {
  readonly txn: Transaction;
  readonly txnIndex: number;
  readonly groupSize: number;
  readonly signerAddress: string;
  readonly requirements?: PaymentRequirements;
  readonly resource?: ResourceInfo;
}): string {
  const req = args.requirements;
  return [
    `Approve x402 payment for ${resourceName(args.resource)}.`,
    req
      ? `Payment: ${req.amount} of asset ${req.asset} to ${compactAddress(req.payTo)}.`
      : 'Payment: exact Algorand payment.',
    `Network: ${formatNetwork(req?.network)}.`,
    `Sign transaction ${args.txnIndex + 1} of ${args.groupSize} as ${compactAddress(args.signerAddress)}.`,
    summarizeTransaction(args.txn),
    `Sender: ${compactAddress(args.txn.sender.toString())}.`,
    resourceDetails(args.resource),
  ]
    .filter(Boolean)
    .join('\n');
}
