/** Server configuration, resolved once from the environment. */

export interface Config {
  readonly transport: 'http' | 'stdio';
  readonly port: number;
  readonly facilitatorUrl: string;
  readonly defaultNetwork: string;
  readonly algodUrl: string;
  readonly algodToken: string;
  readonly maxAmountAtomic: bigint;
  /** Empty set means "any asset is allowed". */
  readonly allowedAssets: ReadonlySet<string>;
  readonly pendingTtlMs: number;
  /** Max payments a single session may hold awaiting signature. */
  readonly maxPendingPayments: number;
  /** Per-request timeout for outbound calls to merchant endpoints. */
  readonly upstreamTimeoutMs: number;
  readonly maxRedirects: number;
  /**
   * Allow outbound requests into private address space. Development only —
   * on a public instance this turns the server into an SSRF pivot.
   */
  readonly allowPrivateEgress: boolean;
}

function str(name: string, fallback: string): string {
  // `??` not `||`: an empty value is meaningful for tokens.
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

function bigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`${name} must be a boolean, got: ${raw}`);
}

function csv(name: string): ReadonlySet<string> {
  const raw = process.env[name];
  if (raw === undefined) return new Set();
  return new Set(
    raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

export function loadConfig(): Config {
  const transport = str('MCP_TRANSPORT', 'http');
  if (transport !== 'http' && transport !== 'stdio') {
    throw new Error(`MCP_TRANSPORT must be "http" or "stdio", got: ${transport}`);
  }

  return {
    transport,
    port: int('PORT', 3000),
    facilitatorUrl: str('X402_FACILITATOR_URL', 'https://facilitator.goplausible.xyz'),
    // Standard base64 genesis hash, with "/" and trailing "=" — not URL-safe.
    defaultNetwork: str(
      'X402_DEFAULT_NETWORK',
      'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
    ),
    algodUrl: str('ALGOD_URL', 'https://mainnet-api.algonode.cloud'),
    algodToken: str('ALGOD_TOKEN', ''),
    maxAmountAtomic: bigint('X402_MAX_AMOUNT_ATOMIC', 1_000_000n),
    allowedAssets: csv('X402_ALLOWED_ASSETS'),
    pendingTtlMs: int('X402_PENDING_TTL_MS', 300_000),
    maxPendingPayments: int('X402_MAX_PENDING_PAYMENTS', 16),
    upstreamTimeoutMs: int('X402_UPSTREAM_TIMEOUT_MS', 30_000),
    maxRedirects: int('X402_MAX_REDIRECTS', 3),
    allowPrivateEgress: bool('X402_ALLOW_PRIVATE_EGRESS', false),
  };
}
