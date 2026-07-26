/**
 * Endpoint discovery, backed by the facilitator's catalog API.
 *
 * Every x402 payment is verified and settled through a facilitator, so the
 * facilitator sees every merchant and every paid endpoint in the network. That
 * makes its catalog the natural discovery index: it is populated by observed
 * payment traffic rather than by voluntary registration.
 *
 * GoPlausible (the Algorand facilitator) exposes this under `/discovery/*`.
 * Merchants are the top-level entity; each merchant owns a set of resources.
 */

import type { PaymentRequirements } from '@x402/core/types';

import { formatNetwork } from './x402/summary.js';

/** CAIP-2 identifiers for Algorand always carry the `algorand:` namespace. */
export function isAlgorandCaip2(network: string | undefined): boolean {
  return typeof network === 'string' && network.startsWith('algorand:');
}

// --- Wire types, mirroring the facilitator's OpenAPI schemas -----------------

interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

interface CatalogedMerchant {
  id: string;
  name?: string;
  description?: string;
  website?: string;
  logo?: string;
  addresses?: { evm?: string; svm?: string; avm?: string };
  categories?: string[];
  resourceCount?: number;
  totalVerifications?: number;
  networks?: string[];
  firstSeen?: string;
  lastSeen?: string;
}

interface CatalogedResource {
  id: string;
  resourceUrl: string;
  method?: string;
  description?: string;
  mimeType?: string;
  merchantId?: string;
  accepts?: PaymentRequirements[];
  /** Declared input/output shape of the endpoint, when the merchant published it. */
  discoveryInfo?: unknown;
  verifyCount?: number;
  settleCount?: number;
  firstSeen?: string;
  lastSeen?: string;
}

interface MerchantsResponse {
  x402Version: number;
  items: CatalogedMerchant[];
  pagination: Pagination;
}

interface ResourcesResponse {
  x402Version: number;
  items: CatalogedResource[];
  pagination: Pagination;
}

// --- Client -----------------------------------------------------------------

export class FacilitatorDiscoveryError extends Error {
  constructor(path: string, status: number, body: string) {
    super(`Facilitator discovery request failed (${path}): HTTP ${status} ${body.slice(0, 200)}`);
    this.name = 'FacilitatorDiscoveryError';
  }
}

export class DiscoveryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, params: Record<string, unknown>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new FacilitatorDiscoveryError(path, response.status, await response.text());
    }
    return (await response.json()) as T;
  }

  listMerchants(params: {
    network?: string;
    search?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<MerchantsResponse> {
    return this.get<MerchantsResponse>('/discovery/merchants', params);
  }

  listResources(params: {
    network?: string;
    search?: string;
    method?: string;
    merchantId?: string;
    limit?: number;
    offset?: number;
  }): Promise<ResourcesResponse> {
    return this.get<ResourcesResponse>('/discovery/resources', params);
  }
}

// --- Agent-facing projections ----------------------------------------------

export interface MerchantSummary {
  readonly merchant_id: string;
  readonly name?: string;
  readonly description?: string;
  readonly website?: string;
  readonly categories?: string[];
  readonly algorand_address?: string;
  readonly endpoint_count?: number;
  readonly total_verifications?: number;
  readonly networks?: string[];
  readonly network_labels?: string[];
  readonly first_seen?: string;
  readonly last_seen?: string;
}

export interface PriceSummary {
  readonly scheme: string;
  readonly network: string;
  readonly network_label: string;
  readonly asset: string;
  readonly amount_atomic: string;
  /** Decimal rendering of `amount_atomic`, when the asset declares its decimals. */
  readonly amount_display?: string;
  readonly pay_to: string;
  readonly max_timeout_seconds?: number;
  /** Present when the facilitator sponsors fees, making the payment gasless. */
  readonly fee_payer?: string;
}

export interface EndpointSummary {
  readonly endpoint_id: string;
  readonly url: string;
  readonly method?: string;
  readonly description?: string;
  readonly mime_type?: string;
  readonly merchant_id?: string;
  readonly pricing: PriceSummary[];
  readonly io_schema?: unknown;
  readonly verify_count?: number;
  readonly settle_count?: number;
  readonly first_seen?: string;
  readonly last_seen?: string;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

/** Renders an atomic amount using the asset decimals the merchant declared. */
function displayAmount(amount: string, extra: unknown): string | undefined {
  const decimals =
    typeof extra === 'object' && extra !== null && 'decimals' in extra
      ? (extra as { decimals?: unknown }).decimals
      : undefined;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) return undefined;

  try {
    const atomic = BigInt(amount);
    if (decimals === 0) return atomic.toString();
    const divisor = 10n ** BigInt(decimals);
    const whole = atomic / divisor;
    const fraction = (atomic % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return undefined;
  }
}

function feePayerOf(extra: unknown): string | undefined {
  if (typeof extra !== 'object' || extra === null || !('feePayer' in extra)) return undefined;
  const value = (extra as { feePayer?: unknown }).feePayer;
  return typeof value === 'string' ? value : undefined;
}

export function toPriceSummary(a: PaymentRequirements): PriceSummary {
  const extra = (a as { extra?: unknown }).extra;
  const timeout = (a as { maxTimeoutSeconds?: number }).maxTimeoutSeconds;
  return {
    scheme: a.scheme,
    network: a.network,
    network_label: formatNetwork(a.network),
    asset: a.asset,
    amount_atomic: a.amount,
    ...optional('amount_display', displayAmount(a.amount, extra)),
    pay_to: a.payTo,
    ...optional('max_timeout_seconds', timeout),
    ...optional('fee_payer', feePayerOf(extra)),
  };
}

export function toMerchantSummary(m: CatalogedMerchant): MerchantSummary {
  return {
    merchant_id: m.id,
    ...optional('name', m.name),
    ...optional('description', m.description),
    ...optional('website', m.website),
    ...optional('categories', m.categories),
    ...optional('algorand_address', m.addresses?.avm),
    ...optional('endpoint_count', m.resourceCount),
    ...optional('total_verifications', m.totalVerifications),
    ...optional('networks', m.networks),
    ...optional('network_labels', m.networks?.map(formatNetwork)),
    ...optional('first_seen', m.firstSeen),
    ...optional('last_seen', m.lastSeen),
  };
}

export function toEndpointSummary(r: CatalogedResource): EndpointSummary {
  // Surface only the Algorand payment options; this server cannot pay the rest.
  const algorandAccepts = (r.accepts ?? []).filter((a) => isAlgorandCaip2(a.network));
  return {
    endpoint_id: r.id,
    url: r.resourceUrl,
    ...optional('method', r.method),
    ...optional('description', r.description),
    ...optional('mime_type', r.mimeType),
    ...optional('merchant_id', r.merchantId),
    pricing: algorandAccepts.map(toPriceSummary),
    ...optional('io_schema', r.discoveryInfo),
    ...optional('verify_count', r.verifyCount),
    ...optional('settle_count', r.settleCount),
    ...optional('first_seen', r.firstSeen),
    ...optional('last_seen', r.lastSeen),
  };
}

/** True when a merchant has at least one Algorand-settled endpoint. */
export function merchantAcceptsAlgorand(m: CatalogedMerchant): boolean {
  return (m.networks ?? []).some(isAlgorandCaip2) || m.addresses?.avm !== undefined;
}

/** Looks up one endpoint by exact URL. The catalog has no get-by-URL route. */
export async function findEndpointByUrl(
  client: DiscoveryClient,
  url: string,
): Promise<EndpointSummary | undefined> {
  const response = await client.listResources({ search: url, limit: 100 });
  const match = response.items.find((r) => r.resourceUrl === url);
  return match ? toEndpointSummary(match) : undefined;
}
