#!/usr/bin/env node
/**
 * Verifies a deployed instance over Streamable HTTP: lists tools, runs a
 * discovery query, and prepares a payment far enough to produce signable bytes.
 * Nothing is signed or submitted, so it never spends.
 *
 * Usage: node scripts/verify-remote.mjs [baseUrl]
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'https://x402-algorand-mcp.fly.dev';

const health = await fetch(new URL('/health', BASE));
console.log(`GET /health -> ${health.status} ${await health.text()}`.trim());

const client = new Client({ name: 'verify-remote', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', BASE)));

const { tools } = await client.listTools();
console.log(`\ntools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) {
    console.log(`\n${name} -> ERROR ${text.slice(0, 200)}`);
    process.exitCode = 1;
    return null;
  }
  return JSON.parse(text);
}

const merchants = await call('list_merchants', { limit: 3 });
console.log(`\nlist_merchants -> ${merchants?.merchants?.length} merchants, ${merchants?.total_in_catalog} in catalog`);

const endpoints = await call('list_endpoints', { limit: 2 });
const first = endpoints?.endpoints?.[0];
console.log(`list_endpoints  -> ${endpoints?.endpoints?.length} endpoints; first: ${first?.url} @ ${first?.pricing?.[0]?.amount_display} ${first?.pricing?.[0]?.network_label}`);

// Session affinity check: prepare_payment parks state on one instance, so this
// only succeeds if the session kept reaching the same machine.
const prepared = await call('prepare_payment', {
  url: first?.url,
  payer_address: 'XJCCGGJ6FL6CFYNXCTO6Q5YQ7E2OIYVRX2G3BVZUF4JOL36HSJRPLYHW5E',
});
console.log(
  `prepare_payment -> ${prepared?.status}; ${prepared?.signing_requests?.length} signing request(s), ` +
    `payment_id ${prepared?.payment_id ? 'issued' : 'MISSING'}`,
);

await client.close();
console.log(`\n${process.exitCode ? 'FAILED' : 'ALL CHECKS PASSED'}`);
process.exit(process.exitCode ?? 0);
