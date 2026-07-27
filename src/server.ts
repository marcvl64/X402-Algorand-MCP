/**
 * MCP server definition: discovery tools over the facilitator catalog, plus the
 * two-step paid-request flow.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Config } from './config.js';
import {
  DiscoveryClient,
  findEndpointByUrl,
  merchantAcceptsAlgorand,
  toEndpointSummary,
  toMerchantSummary,
} from './discovery.js';
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  PaymentService,
  SUPPORTED_NETWORKS,
} from './x402/payment.js';
import { PendingPaymentStore } from './x402/pending.js';
import { createSafeFetch } from './security/safe-fetch.js';

/**
 * Accepts friendly aliases as well as full CAIP-2 ids. Algorand's CAIP-2 form
 * embeds a base64 genesis hash containing "/" and "=", which is unpleasant to
 * type and easy to mangle, so agents should rarely need to.
 */
function resolveNetwork(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const alias = value.trim().toLowerCase();
  if (alias === 'mainnet' || alias === 'algorand-mainnet') return ALGORAND_MAINNET_CAIP2;
  if (alias === 'testnet' || alias === 'algorand-testnet') return ALGORAND_TESTNET_CAIP2;
  return value;
}

export const SERVER_NAME = 'x402-algorand-mcp';
export const SERVER_VERSION = '0.1.0';

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'error';
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message }, null, 2) }],
  };
}

/** Wraps a handler so thrown errors come back as structured tool errors. */
function guard<A>(handler: (args: A) => Promise<ReturnType<typeof json>>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      return failure(err);
    }
  };
}

export interface ServerDeps {
  readonly config: Config;
  readonly discovery: DiscoveryClient;
  readonly payments: PaymentService;
  readonly pending: PendingPaymentStore;
}

export function createDeps(config: Config): ServerDeps {
  const pending = new PendingPaymentStore(config.pendingTtlMs, config.maxPendingPayments);

  // Merchant endpoints are caller-supplied and therefore untrusted: guard the
  // target, bound the time, and re-validate every redirect. The facilitator is
  // operator-configured, so discovery only needs a timeout.
  const merchantFetch = createSafeFetch({
    timeoutMs: config.upstreamTimeoutMs,
    maxRedirects: config.maxRedirects,
    allowPrivate: config.allowPrivateEgress,
  });

  return {
    config,
    discovery: new DiscoveryClient(config.facilitatorUrl),
    payments: new PaymentService(config, pending, merchantFetch),
    pending,
  };
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Discover x402 payment-gated endpoints on Algorand and pay for them.\n\n' +
        'Discovery is served from the facilitator catalog, which is built from observed ' +
        'payment traffic. Merchants are the top-level entity; each owns a set of endpoints.\n\n' +
        'Paying is two steps, because this server holds no keys:\n' +
        '  1. prepare_payment — calls the endpoint and, on HTTP 402, returns the exact bytes ' +
        'that need signing plus a plain-language description of what they authorize.\n' +
        '  2. submit_payment — hand back raw Ed25519 signatures to complete the request.\n\n' +
        'Between those steps, get the bytes signed however you are set up to: an AC2-paired ' +
        'wallet, a wallet MCP, or any other signer. Always show the description to the user ' +
        'before asking for approval.',
    },
  );

  const { config, discovery, payments } = deps;

  server.tool(
    'list_merchants',
    'List merchants selling x402 endpoints on Algorand. Start here for "what merchants are available?".',
    {
      search: z.string().optional().describe('Free-text filter over merchant name and description'),
      category: z.string().optional().describe('Filter by merchant category'),
      network: z
        .string()
        .optional()
        .describe('"mainnet", "testnet", or a full CAIP-2 id. Defaults to all Algorand networks.'),
      limit: z.number().int().min(1).max(100).optional().describe('Results per page (max 100)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
    },
    guard(async (args) => {
      const network = resolveNetwork(args.network);
      const response = await discovery.listMerchants({
        ...(args.search !== undefined ? { search: args.search } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(network !== undefined ? { network } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
      });
      // The catalog spans every chain the facilitator serves; this server only
      // pays on Algorand, so drop merchants it could never transact with.
      const algorandOnly = response.items.filter(merchantAcceptsAlgorand);
      return json({
        merchants: algorandOnly.map(toMerchantSummary),
        returned: algorandOnly.length,
        total_in_catalog: response.pagination.total,
        note:
          algorandOnly.length < response.items.length
            ? 'Non-Algorand merchants were filtered out of this page.'
            : undefined,
      });
    }),
  );

  server.tool(
    'list_endpoints',
    'List x402 endpoints with descriptions and pricing. Pass merchant_id to answer "what does this merchant offer?".',
    {
      merchant_id: z.string().optional().describe('Restrict to one merchant'),
      search: z.string().optional().describe('Free-text filter over endpoint URL and description'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
        .optional()
        .describe('Filter by HTTP method'),
      network: z
        .string()
        .optional()
        .describe('"mainnet", "testnet", or a full CAIP-2 id'),
      limit: z.number().int().min(1).max(100).optional().describe('Results per page (max 100)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
    },
    guard(async (args) => {
      const network = resolveNetwork(args.network);
      const response = await discovery.listResources({
        ...(args.merchant_id !== undefined ? { merchantId: args.merchant_id } : {}),
        ...(args.search !== undefined ? { search: args.search } : {}),
        ...(args.method !== undefined ? { method: args.method } : {}),
        ...(network !== undefined ? { network } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
      });
      const endpoints = response.items.map(toEndpointSummary).filter((e) => e.pricing.length > 0);
      return json({
        endpoints,
        returned: endpoints.length,
        total_in_catalog: response.pagination.total,
      });
    }),
  );

  server.tool(
    'describe_endpoint',
    'Full detail for one endpoint: pricing, accepted assets, and its declared input/output schema. Use before calling a paid endpoint.',
    {
      url: z.string().url().describe('Exact resource URL, as returned by list_endpoints'),
    },
    guard(async (args) => {
      const endpoint = await findEndpointByUrl(discovery, args.url);
      if (!endpoint) {
        return json({
          found: false,
          url: args.url,
          message:
            'Not in the facilitator catalog. It may still be payable — the catalog only lists ' +
            'endpoints that have seen payment traffic. Try prepare_payment directly.',
        });
      }
      return json({ found: true, endpoint });
    }),
  );

  server.tool(
    'prepare_payment',
    'Call an x402 endpoint. Returns the response directly if it is free; on HTTP 402 returns bytes to sign and a description of what signing authorizes. Get those signed by your wallet, then call submit_payment.',
    {
      url: z.string().url().describe('Endpoint to call'),
      payer_address: z
        .string()
        .describe('Algorand address that will pay. Must match the wallet that will sign.'),
      network: z
        .enum(['mainnet', 'testnet'])
        .or(z.string())
        .optional()
        .describe(
          'Pin the payment to one Algorand network: "mainnet", "testnet", or a full CAIP-2 id. ' +
            'Fails if the endpoint does not accept it, rather than paying elsewhere. ' +
            'Omit to use the server default.',
        ),
      method: z.string().optional().describe('HTTP method (default GET)'),
      headers: z.record(z.string()).optional().describe('Extra request headers'),
      body: z.string().optional().describe('Request body, for POST/PUT/PATCH'),
    },
    guard(async (args) => {
      const network = resolveNetwork(args.network);
      const result = await payments.prepare({
        url: args.url,
        payerAddress: args.payer_address,
        ...(network !== undefined ? { network } : {}),
        ...(args.method !== undefined ? { method: args.method } : {}),
        ...(args.headers !== undefined ? { headers: args.headers } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
      });

      if (result.status === 'payment_required') {
        return json({
          ...result,
          next_step:
            'Show each signing_requests[].description to the user for approval. Sign the raw ' +
            'bytes in payload_base64 with Ed25519 (do not wrap them in a transaction), then ' +
            'call submit_payment with payment_id and the base64 signatures.',
        });
      }
      return json(result);
    }),
  );

  server.tool(
    'submit_payment',
    'Complete a prepared payment by supplying signatures, and return the paid resource.',
    {
      payment_id: z.string().describe('payment_id from prepare_payment'),
      signatures: z
        .array(
          z.object({
            index: z.number().int().min(0).describe('Matching signing_requests[].index'),
            signature_base64: z.string().describe('Raw 64-byte Ed25519 signature, base64'),
          }),
        )
        .min(1)
        .describe('One signature per signing request'),
    },
    guard(async (args) => json(await payments.submit(args.payment_id, args.signatures))),
  );

  server.tool(
    'get_payment_config',
    'Server configuration an agent needs before paying: facilitator, default network, and spend limits.',
    {},
    guard(async () =>
      json({
        facilitator_url: config.facilitatorUrl,
        default_network: config.defaultNetwork,
        supported_networks: SUPPORTED_NETWORKS,
        network_aliases: { mainnet: ALGORAND_MAINNET_CAIP2, testnet: ALGORAND_TESTNET_CAIP2 },
        algod_url: config.algodUrl,
        max_amount_atomic: config.maxAmountAtomic.toString(),
        allowed_assets:
          config.allowedAssets.size > 0 ? [...config.allowedAssets] : 'any',
        pending_payment_ttl_ms: config.pendingTtlMs,
        holds_keys: false,
        signing_model:
          'This server never holds keys. It emits raw Ed25519 signing payloads and accepts ' +
          'signatures from any signer the calling agent uses.',
      }),
    ),
  );

  return server;
}
