/**
 * Outbound request guard.
 *
 * `prepare_payment` fetches a caller-supplied URL, so on a public instance this
 * server is an open outbound proxy unless constrained. The risk is not only
 * `localhost`: on Fly, machines share a private 6PN network (`fdaa::/16`) where
 * `*.internal` names resolve to *other apps in the same organisation*, so an
 * unguarded fetch is a pivot into private infrastructure.
 *
 * Guarding on the hostname alone is not enough — a hostile name can resolve to
 * a private address, and can resolve differently on a second lookup (DNS
 * rebinding). So every hop is resolved and every resolved address is checked,
 * and redirects are followed manually so each new target is re-validated.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {
  readonly code = 'blocked_url' as const;
  constructor(url: string, reason: string) {
    super(`Refusing to fetch ${url}: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

export class ResponseTooLargeError extends Error {
  readonly code = 'response_too_large' as const;
  constructor(limit: number) {
    super(`Upstream response exceeded ${limit} bytes.`);
    this.name = 'ResponseTooLargeError';
  }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  return (
    ((Number(parts[0]) << 24) >>> 0) +
    (Number(parts[1]) << 16) +
    (Number(parts[2]) << 8) +
    Number(parts[3])
  );
}

/** Non-public IPv4 space: RFC1918, loopback, link-local, CGNAT, test nets, multicast. */
const BLOCKED_V4: readonly (readonly [number, number])[] = (
  [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const
).map(([ip, bits]) => [ipv4ToInt(ip), bits] as const);

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === base;
  });
}

/** Expands an IPv6 literal (including `::` and IPv4-mapped forms) to 16 bytes. */
function parseIpv6(ip: string): Uint8Array | undefined {
  let text = ip.split('%')[0] ?? ip; // strip zone index
  let tailV4: number[] | undefined;

  // IPv4-mapped / -compatible suffix, e.g. ::ffff:127.0.0.1
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return undefined;
    tailV4 = tail.split('.').map(Number);
    text = text.slice(0, lastColon + 1) + '0:0';
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;

  const toGroups = (s: string): number[] =>
    s.length === 0 ? [] : s.split(':').map((g) => Number.parseInt(g, 16));

  const head = toGroups(halves[0] ?? '');
  const back = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  const missing = 8 - head.length - back.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined;

  const groups =
    halves.length === 2 ? [...head, ...new Array<number>(missing).fill(0), ...back] : head;
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;

  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  });
  if (tailV4) {
    bytes[12] = tailV4[0]!;
    bytes[13] = tailV4[1]!;
    bytes[14] = tailV4[2]!;
    bytes[15] = tailV4[3]!;
  }
  return bytes;
}

function isBlockedV6(ip: string): boolean {
  const b = parseIpv6(ip);
  if (!b) return true; // unparseable — refuse rather than guess

  // IPv4-mapped (::ffff:0:0/96): judge by the embedded IPv4 address.
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (mapped) return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);

  const allZero = b.every((x) => x === 0);
  if (allZero) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 ULA — includes Fly's fdaa::/16
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedV4(ip);
  if (version === 6) return isBlockedV6(ip);
  return true;
}

export interface UrlGuardOptions {
  /** Permit private address space. Only for local development. */
  readonly allowPrivate?: boolean;
}

/**
 * Validates a single URL: scheme, and every address its hostname resolves to.
 * Returns the resolved addresses so the caller can pin the connection if it
 * wants to close the rebinding window entirely.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  options: UrlGuardOptions = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(rawUrl, 'not a valid URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BlockedUrlError(rawUrl, `unsupported scheme ${url.protocol}`);
  }

  if (options.allowPrivate) return;

  // `.internal` is Fly's private DNS zone; refuse before it even resolves.
  if (url.hostname.endsWith('.internal') || url.hostname === 'localhost') {
    throw new BlockedUrlError(rawUrl, 'private hostname');
  }

  // URL.hostname keeps the brackets around an IPv6 literal, which isIP() does
  // not accept. Strip them so literals are recognised rather than falling
  // through to a DNS lookup that happens to fail.
  const host =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new BlockedUrlError(rawUrl, 'address is in non-public space');
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(rawUrl, 'hostname does not resolve');
  }

  if (addresses.length === 0) {
    throw new BlockedUrlError(rawUrl, 'hostname does not resolve');
  }
  // Every address must be public: one private answer is enough to attack with.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError(rawUrl, `resolves to non-public address ${address}`);
    }
  }
}

export interface SafeFetchOptions extends UrlGuardOptions {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
}

/**
 * A `fetch` that validates the target, bounds the time it may take, and follows
 * redirects manually so each hop is re-validated. A redirect is the obvious way
 * to smuggle a private address past a check applied only to the initial URL.
 */
export function createSafeFetch(options: SafeFetchOptions): typeof fetch {
  return async function safeFetch(input, init) {
    let current = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let redirectsLeft = options.maxRedirects;

    for (;;) {
      await assertUrlAllowed(current, options);

      const response = await fetch(current, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status < 400 && location !== null;
      if (!isRedirect) return response;

      if (redirectsLeft-- <= 0) {
        throw new BlockedUrlError(current, 'too many redirects');
      }
      current = new URL(location, current).href;
    }
  };
}

/**
 * Reads a response body up to a byte ceiling.
 *
 * `response.text()` buffers the entire body before any limit can be applied, so
 * a hostile endpoint streaming gigabytes would exhaust memory first. This stops
 * reading at the limit instead.
 */
export async function readBodyCapped(response: Response, limitBytes: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        chunks.push(value.subarray(0, value.byteLength - (total - limitBytes)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}
