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

**Try it now** — a public instance runs at `https://x402-algorand-mcp.fly.dev/mcp`:

```sh
claude mcp add --transport http x402-algorand https://x402-algorand-mcp.fly.dev/mcp
```

See [Connecting to it](#connecting-to-it) for other clients, running it locally, or deploying your
own.

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

## Connecting to it

Three ways in, depending on whether you want zero setup, a local build, or your own deployment.

### 1. Hosted instance — nothing to install

A public instance runs at:

```
https://x402-algorand-mcp.fly.dev/mcp
```

**Claude Code:**

```sh
claude mcp add --transport http x402-algorand https://x402-algorand-mcp.fly.dev/mcp
```

**Claude Desktop** — *Settings → Connectors → Add custom connector*, and paste the same URL. On
builds without custom connectors, bridge it through stdio in `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "x402-algorand": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://x402-algorand-mcp.fly.dev/mcp"]
    }
  }
}
```

**Any MCP client** that speaks Streamable HTTP can point at the URL directly.

Then ask *"what x402 merchants are available on Algorand?"* or *"what does merchant X offer?"*.

> The hosted instance is unauthenticated and offered as-is, with a spend ceiling of 1 USDC per
> payment. It holds no keys and cannot move funds — every payment still requires a signature from
> your own signer. For anything you depend on, deploy your own (below).

### 2. Run it locally over stdio

Best for development, or if you would rather not send endpoint URLs through someone else's server.

```sh
pnpm install
pnpm build
```

**Claude Code:**

```sh
claude mcp add x402-algorand -e MCP_TRANSPORT=stdio -- node "$PWD/dist/index.js"
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "x402-algorand": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/X402-Algorand-MCP/dist/index.js"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

Two things that trip people up here. Use an **absolute path to `node`** — Claude Desktop launches
servers with a minimal `PATH` that often excludes Homebrew, and a bare `node` silently fails to
start. And because the client spawns the server with its own working directory, **a `.env` file is
not read**; put configuration in the `env` block instead. (`pnpm start` and `pnpm start:stdio` do
read `.env`, since they run from the project root.)

Restart Claude Desktop fully (⌘Q on macOS) after editing the config.

### 3. Deploy your own

See [Deployment](#deployment).

## Choosing a network

Network is chosen **per call**, not baked into the deployment. Pass `network` to any tool as
`"mainnet"`, `"testnet"`, or a full CAIP-2 id:

```jsonc
{ "url": "https://…", "payer_address": "XJCC…", "network": "testnet" }
```

If the endpoint does not accept the network you pinned, the call **fails** rather than paying on a
different chain:

```
Endpoint does not accept payment on algorand:SGO1GKSz…
It accepts: algorand:wGHE2Pwd…
```

Omit `network` and the server uses `X402_DEFAULT_NETWORK` as a *preference*, falling back to
whatever the endpoint offers. The catalog currently holds ~643 MainNet and ~37 TestNet endpoints;
TestNet ones price in TestNet USDC (ASA `10458941`), so they cost nothing real to exercise.

## Testing

Exercise everything end to end against the live catalog, no MCP client needed. Both scripts stop at
the point where signable bytes are produced, so neither ever spends.

Against a local build:

```sh
pnpm build && pnpm smoke
# or pin a network and endpoint:
node scripts/smoke.mjs <payerAddress> https://gateway-x402.vercel.app/discover
```

Against a deployed instance, over Streamable HTTP:

```sh
node scripts/verify-remote.mjs                             # the hosted instance
node scripts/verify-remote.mjs https://your-app.fly.dev     # your own
```

`verify-remote.mjs` doubles as a session-affinity check: `prepare_payment` parks state on one
machine, so it only succeeds if the session kept reaching the same instance.

Any syntactically valid Algorand address works for `prepare_payment` — the transaction group is
built but never signed or submitted.

### Testing a real payment

Completing a payment needs a signer, which this server deliberately does not have. To close the loop
on TestNet: take `signing_requests[].payload_base64`, sign those raw bytes with Ed25519 using a
TestNet key (funded from the [dispenser](https://bank.testnet.algorand.network/) and opted in to ASA
`10458941`), then call `submit_payment` with the base64 signature. Sign the bytes **directly** — do
not re-wrap them in a transaction.

## Configuration

See [`.env.example`](./.env.example). The values worth knowing:

| Variable | Default | Notes |
|---|---|---|
| `X402_FACILITATOR_URL` | `https://facilitator.goplausible.xyz` | Backs all discovery. |
| `X402_DEFAULT_NETWORK` | Algorand MainNet CAIP-2 | Only a *default* — callers override it per request. Standard base64 genesis hash: contains `/` and a trailing `=`, not the URL-safe variant. |
| `ALGOD_URL` | AlgoNode MainNet | Used for `X402_DEFAULT_NETWORK`; other networks fall back to public AlgoNode endpoints. |
| `X402_MAX_AMOUNT_ATOMIC` | `1000000` | Server-side spend ceiling, in atomic units. |
| `X402_ALLOWED_ASSETS` | *(any)* | Comma-separated ASA IDs. |
| `X402_PENDING_TTL_MS` | `300000` | How long a prepared payment waits for signatures. |
| `X402_MAX_PENDING_PAYMENTS` | `16` | Payments one session may park awaiting signature. |
| `X402_UPSTREAM_TIMEOUT_MS` | `30000` | Timeout for calls to merchant endpoints. |
| `X402_MAX_REDIRECTS` | `3` | Redirect hops followed, each re-validated. |
| `MCP_MAX_SESSIONS` | `256` | Concurrent sessions before new ones are refused. |
| `X402_ALLOW_PRIVATE_EGRESS` | `false` | Permit requests to private IPs. **Development only.** |

The spend guardrails are a **backstop, not the primary control**. The signer enforces its own policy
and is the only party that can actually authorize a spend.

## Deployment

The server keeps prepared payments in memory between `prepare_payment` and `submit_payment`, so an
MCP session must keep reaching the same instance. **Run a single instance**, or use sticky sessions
behind a load balancer. That rules out serverless platforms — a suspended in-flight request cannot
be frozen and revived on another invocation.

It has no native dependencies and needs no WebRTC, so it runs anywhere Node 20.12+ does.

### Fly.io

[`fly.toml`](./fly.toml) and the [`Dockerfile`](./Dockerfile) are ready to go.

```sh
fly launch --no-deploy       # first run only — keep the committed fly.toml
fly deploy
fly scale count 1            # exactly one machine; see below
node scripts/verify-remote.mjs https://your-app.fly.dev
```

Change `app` in `fly.toml` to your own name first. Your instance is then at
`https://your-app.fly.dev/mcp`.

**Do not accept Fly's generated `fly.toml` over the committed one.** Its template sets
`auto_stop_machines = 'stop'` and `min_machines_running = 0`, which is a correctness bug here rather
than a cost setting: a stopped machine drops every parked payment and kills live MCP sessions, so
users see payments that silently never complete. Keep:

```toml
auto_stop_machines = 'off'
min_machines_running = 1
```

For the same reason, stay at **one machine**. Sessions load-balanced across two will prepare a
payment on one and submit to the other, which fails.

Verify the image locally before pushing — faster than debugging a remote build:

```sh
docker build -t x402-algorand-mcp .
docker run --rm -p 3000:3000 x402-algorand-mcp
curl localhost:3000/health
```

### Continuous deployment

[`.github/workflows/fly-deploy.yml`](./.github/workflows/fly-deploy.yml) typechecks and tests, then
deploys on every push to `main`. It needs one secret:

```sh
fly tokens create deploy -x 999999h    # run in a real terminal
gh secret set FLY_API_TOKEN            # paste at the prompt
```

### Exposing it publicly

The server has no authentication by design — it holds no keys and cannot move funds without an
external signature. Before advertising an instance, consider adding **rate limiting at the edge**
(Fly, Cloudflare); it is the one abuse control not implemented in the app. See
[Security](#security).

### pnpm version pinning

`packageManager` pins pnpm to the version that wrote `pnpm-lock.yaml`. Without it, Corepack installs
whatever is current — recent pnpm reads `onlyBuiltDependencies` from `pnpm-workspace.yaml` rather
than `package.json`, so a container would fail `pnpm install` with `ERR_PNPM_IGNORED_BUILDS` while
the same command succeeded locally. Bump the pin and the lockfile together.

## Security

The server is designed to run as a public, unauthenticated instance, so it treats both the caller
and the merchant endpoint as hostile.

**Signing requests cannot be spoofed.** The description a human reads before approving is built from
the *decoded transaction*, never from the merchant's 402 challenge — the transaction is what gets
signed; the challenge is only a claim about it. Merchant-supplied text is stripped of newlines,
control characters and bidi overrides, truncated, quoted, and confined below an
`--- unverified merchant text ---` marker. Without this, a merchant could embed a newline in a
`description` field and forge a `Paying …` line, showing one amount while the user signs another.

Before any signature is requested, the built transaction is checked against the quote that spend
limits were applied to. A mismatch in asset, recipient, or amount aborts the payment.

**Outbound requests are constrained.** `prepare_payment` fetches a caller-supplied URL, so every
target is resolved and every resolved address checked against non-public ranges — including
loopback, RFC1918, link-local (cloud metadata), CGNAT, and IPv6 ULA, which covers Fly's `fdaa::/16`
private network where `*.internal` names reach other apps in your organisation. Redirects are
followed manually so each hop is re-validated, defeating redirect-based bypasses. Only `http(s)` is
allowed. Set `X402_ALLOW_PRIVATE_EGRESS=true` for local development only.

**Resources are bounded.** Response bodies are read with a hard cap rather than buffered whole,
outbound requests time out, and both parked payments and concurrent sessions are capped.

Not implemented: rate limiting. Put it at the edge if you expose this widely.

The server holds no keys, so nothing it does can move funds without an external signature.

## Development

```sh
pnpm typecheck
pnpm test
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
