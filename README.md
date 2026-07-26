# X402-Algorand-MCP

A remote [MCP](https://modelcontextprotocol.io) server that lets any agent **discover
[x402](https://x402.org) payment-gated endpoints on Algorand and pay for them** — without ever
handing the server a key.

```
                 ┌─────────────────────┐
  agent ◄──MCP──►│  X402-Algorand-MCP  │──── discovery ───► facilitator catalog
    │            │   (holds no keys)   │──── paid call ───► merchant endpoint
    │            └─────────────────────┘
    │
    └── "sign these bytes" ──► whatever signer the agent has
                               (AC2-paired wallet · wallet MCP · local key)
```

## What it does

**Discovery.** Every x402 payment is verified and settled through a facilitator, so the facilitator
observes every merchant and every paid endpoint in the network. That makes its catalog a discovery
index built from real payment traffic rather than voluntary registration. This server exposes it as
MCP tools, so an agent can answer:

- *"What merchants are available?"* → `list_merchants`
- *"What does this merchant offer?"* → `list_endpoints({ merchant_id })`
- *"What does this endpoint cost, and what does it take as input?"* → `describe_endpoint`

**Payment.** When the agent calls a paid endpoint and gets HTTP 402, this server builds the Algorand
transaction group the payment requires, then **stops** and hands back the exact bytes that need
signing along with a plain-language description of what signing authorizes. The agent gets those
signed however it is set up to, and submits the signatures to complete the call.

## The server holds no keys

This is the central design constraint, and it is what makes the server deployable as a shared,
remote service.

Paying is therefore two steps:

| Step | Tool | What happens |
|---|---|---|
| 1 | `prepare_payment` | Calls the endpoint. Free? You get the response. HTTP 402? You get signable bytes + a description. |
| 2 | `submit_payment` | You return raw Ed25519 signatures; the request completes and you get the resource. |

Between those two steps, **how the bytes get signed is entirely the agent's business.** The server
is deliberately agnostic:

- an [AC2](https://github.com/algorandfoundation/ac2)-paired wallet, where a human approves the
  payment on their own device and the signature is delegated back to the agent;
- a wallet MCP that is already authorized to sign payment transactions autonomously;
- a local keypair in a test harness.

All three satisfy the same contract: *receive bytes plus a description, return a 64-byte Ed25519
signature.* Nothing in this codebase imports an AC2 SDK or knows which of these is on the other end.

> The signing request maps cleanly onto an AC2 `SigningRequest` body (`description`, `payload`,
> `schema`, `sig_hint`) so the AC2 path is a direct field mapping — but that is a convenience, not a
> coupling.

### Why two steps rather than one

An Algorand transaction group is built with fixed validity rounds and a group ID. It cannot be
rebuilt identically on a second call, so the flow cannot restart after signing — it must *suspend*.
`prepare_payment` leaves the in-flight payment parked in memory until its signatures arrive or it
expires (default 5 minutes; the validity window makes anything longer useless).

## Tools

| Tool | Purpose |
|---|---|
| `list_merchants` | Merchants selling x402 endpoints on Algorand. Filter by search, category, network. |
| `list_endpoints` | Endpoints with descriptions and pricing. Pass `merchant_id` to scope to one merchant. |
| `describe_endpoint` | Full detail for one endpoint: pricing, assets, and its declared input/output schema. |
| `prepare_payment` | Call an endpoint; on 402 return bytes to sign. |
| `submit_payment` | Supply signatures, get the paid resource. |
| `get_payment_config` | Facilitator, default network, and spend limits in force. |

Discovery results are filtered to Algorand: the catalog spans every chain the facilitator serves,
and this server can only pay on Algorand.

## Quick start

```sh
pnpm install
cp .env.example .env     # defaults point at Algorand MainNet via GoPlausible
pnpm build
pnpm start               # Streamable HTTP on :3000/mcp
```

For local development against a desktop MCP client:

```sh
pnpm start:stdio
```

Verify it end to end against the live catalog — this stops at the point where signable bytes are
produced, so it never spends:

```sh
pnpm build && node scripts/smoke.mjs
```

## Configuration

See [`.env.example`](./.env.example). The values worth knowing:

| Variable | Default | Notes |
|---|---|---|
| `X402_FACILITATOR_URL` | `https://facilitator.goplausible.xyz` | Backs all discovery. |
| `X402_DEFAULT_NETWORK` | Algorand MainNet CAIP-2 | Standard base64 genesis hash — contains `/` and a trailing `=`, not the URL-safe variant. |
| `ALGOD_URL` | AlgoNode MainNet | Must match `X402_DEFAULT_NETWORK`. |
| `X402_MAX_AMOUNT_ATOMIC` | `1000000` | Server-side spend ceiling, in atomic units. |
| `X402_ALLOWED_ASSETS` | *(any)* | Comma-separated ASA IDs. |
| `X402_PENDING_TTL_MS` | `300000` | How long a prepared payment waits for signatures. |

The spend guardrails are a **backstop, not the primary control**. The signer enforces its own policy
and is the only party that can actually authorize a spend.

## Deployment

The server keeps prepared payments in memory between `prepare_payment` and `submit_payment`, so an
MCP session must keep reaching the same instance. Run a single instance, or use sticky sessions
behind a load balancer.

It has no native dependencies and needs no WebRTC, so it runs anywhere Node 20+ does.

## Development

```sh
pnpm typecheck
pnpm test
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
