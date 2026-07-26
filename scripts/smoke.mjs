#!/usr/bin/env node
/**
 * End-to-end smoke test against the live facilitator catalog.
 *
 * Exercises every discovery tool, then runs prepare_payment against a real
 * payment-gated endpoint. Nothing is signed and nothing is submitted — the run
 * stops at the point where signable bytes are produced, so it never spends.
 *
 * Usage:
 *   pnpm build && node scripts/smoke.mjs [payerAddress] [endpointUrl]
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', 'dist', 'index.js');

// Any valid Algorand address works: the group is built but never signed.
const PAYER = process.argv[2] ?? 'XJCCGGJ6FL6CFYNXCTO6Q5YQ7E2OIYVRX2G3BVZUF4JOL36HSJRPLYHW5E';
const ENDPOINT = process.argv[3] ?? 'https://api.syraa.fun/insights/network-health';

const client = new Client({ name: 'x402-algorand-mcp-smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: 'node',
    args: [serverEntry],
    env: { ...process.env, MCP_TRANSPORT: 'stdio' },
  }),
);

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  console.log(`\n=== ${name}${result.isError ? ' [ERROR]' : ''} ===`);
  console.log(text.length > 1200 ? `${text.slice(0, 1200)}\n… (truncated)` : text);
  if (result.isError) process.exitCode = 1;
  return text;
}

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

await call('get_payment_config');

const merchants = JSON.parse(await call('list_merchants', { limit: 3 }));
const merchantId = merchants.merchants?.[0]?.merchant_id;
if (merchantId) await call('list_endpoints', { merchant_id: merchantId, limit: 2 });

await call('describe_endpoint', { url: ENDPOINT });
await call('prepare_payment', { url: ENDPOINT, payer_address: PAYER });

await client.close();
process.exit(process.exitCode ?? 0);
