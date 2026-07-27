import { describe, expect, it } from 'vitest';

import { assertUrlAllowed, isBlockedAddress, readBodyCapped } from './safe-fetch.js';

describe('isBlockedAddress', () => {
  it('blocks IPv4 private, loopback, link-local and CGNAT space', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks Fly's private 6PN range and other IPv6 non-public space", () => {
    for (const ip of [
      'fdaa:0:1::3', // Fly 6PN — reaches other apps in the org
      'fc00::1', // ULA
      'fe80::1', // link-local
      '::1', // loopback
      '::', // unspecified
      'ff02::1', // multicast
      '2001:db8::1', // documentation
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('2a00:1450:4009:81f::200e')).toBe(false);
  });

  it('sees through IPv4-mapped IPv6, which would otherwise bypass the v4 rules', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('refuses anything it cannot parse rather than guessing', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  it('rejects non-http schemes', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/unsupported scheme/);
    await expect(assertUrlAllowed('gopher://x/1')).rejects.toThrow(/unsupported scheme/);
  });

  it('rejects malformed URLs', async () => {
    await expect(assertUrlAllowed('not a url')).rejects.toThrow(/not a valid URL/);
  });

  it("rejects Fly's .internal zone and localhost by name", async () => {
    await expect(assertUrlAllowed('http://myapp.internal/admin')).rejects.toThrow(
      /private hostname/,
    );
    await expect(assertUrlAllowed('http://localhost:3000/')).rejects.toThrow(/private hostname/);
  });

  it('rejects private address literals without a DNS lookup', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /non-public space/,
    );
    await expect(assertUrlAllowed('http://[::1]:8080/')).rejects.toThrow(/non-public space/);
  });

  it('allows public address literals', async () => {
    await expect(assertUrlAllowed('https://8.8.8.8/')).resolves.toBeUndefined();
  });

  it('can be opened up for local development', async () => {
    await expect(
      assertUrlAllowed('http://localhost:3000/', { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });
});

describe('readBodyCapped', () => {
  it('stops reading at the limit instead of buffering the whole body', async () => {
    const chunk = new Uint8Array(1024).fill(97); // 'a'
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Would run forever if the cap were not enforced.
        emitted += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const text = await readBodyCapped(new Response(body), 4096);

    expect(text.length).toBe(4096);
    expect(emitted).toBeLessThan(100_000);
  });

  it('returns short bodies whole', async () => {
    expect(await readBodyCapped(new Response('hello'), 4096)).toBe('hello');
  });

  it('handles an empty body', async () => {
    expect(await readBodyCapped(new Response(null), 4096)).toBe('');
  });
});

describe('IPv6 literals in URLs', () => {
  it('recognises bracketed IPv6 as a literal rather than a hostname', async () => {
    // URL.hostname keeps the brackets; if they are not stripped these fall
    // through to DNS and are blocked for the wrong reason.
    await expect(assertUrlAllowed('http://[fdaa:0:1::3]/')).rejects.toThrow(/non-public space/);
    await expect(assertUrlAllowed('http://[::ffff:169.254.169.254]/')).rejects.toThrow(
      /non-public space/,
    );
  });

  it('allows public bracketed IPv6', async () => {
    await expect(assertUrlAllowed('https://[2606:4700:4700::1111]/')).resolves.toBeUndefined();
  });
});
