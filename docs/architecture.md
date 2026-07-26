# Architecture

## The constraint everything follows from

The server holds no signing keys. It is intended to run as a shared remote service, so it cannot
custody anything, and it must work for agents whose signers it knows nothing about.

Everything below is downstream of that.

## Signer independence

The server's entire interface to signing is:

```jsonc
{
  "index": 1,
  "payload_base64": "VFiLpGFhbXTNJxCk…",   // raw bytes, TX-prefixed, ready for Ed25519
  "description": "Approve x402 payment for …\nPayment: 10000 of asset 31566704 to XJCC…\n…",
  "signer_address": "XJCCGGJ6FL6CFYNXCTO6Q5YQ7E2OIYVRX2G3BVZUF4JOL36HSJRPLYHW5E",
  "schema": "x402/exact/algorand/v2/transaction-signing-bytes",
  "sig_hint": "raw-ed25519"
}
```

and back:

```jsonc
{ "index": 1, "signature_base64": "<64 raw bytes>" }
```

Three signers satisfy this identically:

| Signer | Who approves | Server's knowledge |
|---|---|---|
| AC2-paired wallet | A human, on their own device, via a delegated `SigningRequest` | none |
| Wallet MCP | The agent, under pre-granted authority | none |
| Local keypair | Nothing — test harness | none |

No module in `src/` imports an AC2 SDK. `description` exists because *some* signers put a human in
the loop and that human must see what they are approving; autonomous signers can use it for logging
and policy. `schema` and `sig_hint` are named to map onto AC2's `SigningRequest` fields, which makes
the AC2 adapter a field rename — but that is a convenience for implementers, not a dependency.

## Discovery

x402 routes every payment through a facilitator for verification and settlement. The facilitator
therefore observes the whole market, and its catalog is populated by real payment traffic rather
than by merchants opting in.

GoPlausible, the Algorand facilitator, exposes this at `/discovery/*`:

| Route | Used for |
|---|---|
| `GET /discovery/merchants` | `list_merchants` |
| `GET /discovery/resources` | `list_endpoints`, `describe_endpoint` |

Merchants are the top-level entity; each owns a set of resources, linked by `merchantId`. That
mirrors how users actually ask about the space — *who is out there*, then *what do they sell*.

`src/discovery.ts` is a typed client over that API plus projections that:

- drop non-Algorand payment options, which this server cannot pay;
- render atomic amounts using the asset's declared decimals (`"10000"` → `"0.01"`);
- surface `feePayer` when present, which signals the payment is gasless;
- omit absent optional fields entirely rather than emitting `null`s.

There is no get-by-URL route, so `describe_endpoint` searches and matches locally. An endpoint absent
from the catalog may still be payable — the catalog only lists endpoints that have seen traffic — so
that case returns a `found: false` result that points at `prepare_payment` rather than an error.

## The suspended payment

The scheme implementation (`ExactAvmScheme`) builds a transaction group and hands it to a
`ClientAvmSigner` synchronously, mid-flight. With no keys, the server cannot answer.

It also cannot simply return the transactions and rebuild them later: an Algorand transaction carries
validity rounds and a group ID fixed at build time, so a second build produces *different*
transactions than the ones that got signed.

So the flow **suspends** rather than restarts. `DeferredSigner` (`src/x402/pending.ts`) implements
`ClientAvmSigner` and never signs:

1. decodes each transaction it is handed;
2. verifies the sender matches the declared payer;
3. publishes the signing requests, resolving `whenRequestsReady()`;
4. `await`s an internal promise — the whole HTTP request is now parked here;
5. on `settle()`, assembles signed transactions and returns them, letting the request complete.

`PendingPaymentStore` holds parked payments under a TTL (default 5 minutes — longer is pointless
given the validity window) and aborts them on expiry or session close.

```
prepare_payment ──► fetch ──► 402 ──► select option ──► policy check ──► build group
                                                                             │
                                        ┌────── signing requests ◄───────────┘
                                        │              (flow parked)
                                   [ agent signs ]
                                        │
submit_payment  ──► settle() ──────────►┘──► assemble ──► retry with PAYMENT-SIGNATURE ──► resource
```

### Protocol details left to the SDK

The HTTP mechanics are handled by `wrapFetchWithPayment` rather than hand-rolled, because two are
easy to get wrong:

- x402 **v2 sends the payment on a `PAYMENT-SIGNATURE` request header**; `X-PAYMENT` is v1 only.
- A 402 challenge may arrive on a `PAYMENT-REQUIRED` response header instead of in the body.

The server's own logic sits in the `paymentRequirementsSelector`, which runs after the challenge is
parsed and before anything is built. That is where the Algorand option is chosen and vetted.

Because schemes must be registered before the challenge is seen, every Algorand network the server
can pay on is registered up front; the selector then picks among whatever the endpoint actually
offers.

## Spend guardrails

`X402_MAX_AMOUNT_ATOMIC` and `X402_ALLOWED_ASSETS` are enforced in the selector, before any signing
request is emitted. They bound what the server will ever *ask* to be signed.

They are a backstop. The signer holds the keys, enforces its own policy, and is the only party that
can actually authorize a spend.

## State and deployment

The parked-payment map is the server's only mutable state. It is short-lived by construction, but it
does mean an MCP session must keep reaching the same instance — run one instance, or use sticky
sessions.

There are no native dependencies and no WebRTC, so the server runs anywhere Node 20+ does. Session
teardown aborts any payments still parked, so a dropped connection cannot leave a flow suspended.
