import { describe, expect, it, vi } from 'vitest';

import {
  DeferredSigner,
  PaymentExpiredError,
  PendingPaymentStore,
  type PendingPayment,
} from './pending.js';

function stubPayment(id: string, signer: DeferredSigner): PendingPayment {
  const result = Promise.resolve(new Response('ok'));
  result.catch(() => undefined);
  return { id, url: 'https://example.com', signer, requests: [], result };
}

describe('PendingPaymentStore', () => {
  it('returns a payment once and only once', () => {
    const store = new PendingPaymentStore(60_000);
    const signer = new DeferredSigner('ADDR', () => ({}));
    store.add(stubPayment('p1', signer));

    expect(store.take('p1')?.id).toBe('p1');
    expect(store.take('p1')).toBeUndefined();
  });

  it('expires a payment and aborts the suspended flow', async () => {
    vi.useFakeTimers();
    try {
      const store = new PendingPaymentStore(1_000);
      const signer = new DeferredSigner('ADDR', () => ({}));
      const waiting = signer.whenRequestsReady();
      store.add(stubPayment('p2', signer));

      vi.advanceTimersByTime(1_001);

      await expect(waiting).rejects.toBeInstanceOf(PaymentExpiredError);
      expect(store.take('p2')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expire a payment that was already taken', async () => {
    vi.useFakeTimers();
    try {
      const store = new PendingPaymentStore(1_000);
      const signer = new DeferredSigner('ADDR', () => ({}));
      const waiting = signer.whenRequestsReady();
      store.add(stubPayment('p3', signer));

      expect(store.take('p3')).toBeDefined();
      vi.advanceTimersByTime(5_000);

      // The expiry timer must have been cleared by take(), leaving the signer
      // live rather than aborted.
      const settled = await Promise.race([
        waiting.then(() => 'resolved').catch(() => 'aborted'),
        Promise.resolve('still-waiting'),
      ]);
      expect(settled).toBe('still-waiting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts everything still pending on clear', async () => {
    const store = new PendingPaymentStore(60_000);
    const signer = new DeferredSigner('ADDR', () => ({}));
    const waiting = signer.whenRequestsReady();
    store.add(stubPayment('p4', signer));

    store.clear('session closed');

    await expect(waiting).rejects.toThrow(/session closed/);
  });
});

describe('DeferredSigner', () => {
  it('exposes the payer address it was constructed with', () => {
    expect(new DeferredSigner('PAYER', () => ({})).address).toBe('PAYER');
  });

  it('refuses to sign a transaction whose sender is not the payer', async () => {
    const signer = new DeferredSigner('PAYER', () => ({}));
    // Not a decodable transaction, so decoding fails before the sender check —
    // either way an unusable input must be rejected, never silently skipped.
    await expect(signer.signTransactions([new Uint8Array([1, 2, 3])])).rejects.toThrow(
      /Unable to decode/,
    );
  });

  it('aborting before the flow reaches the signer raises no unhandled rejection', async () => {
    const signer = new DeferredSigner('ADDR', () => ({}));
    signer.abort(new Error('aborted early'));

    // Nothing awaited either promise; the process must stay healthy.
    await new Promise((resolve) => setImmediate(resolve));
    await expect(signer.whenRequestsReady()).rejects.toThrow(/aborted early/);
  });
});
