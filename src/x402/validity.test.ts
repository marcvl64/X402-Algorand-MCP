import { describe, expect, it } from 'vitest';

import { validityRoundsFor } from './payment.js';

describe('validityRoundsFor', () => {
  it('covers the full pending TTL, with margin', () => {
    // 5 minutes at ~2.9s/round is ~104 rounds; the margin puts it comfortably
    // past the point where the server would still accept signatures.
    const rounds = validityRoundsFor(300_000);
    expect(rounds).toBeGreaterThan(300 / 2.9);
    expect(rounds).toBeLessThan(200);
  });

  it('never returns less than algokit\'s 10-round default', () => {
    expect(validityRoundsFor(0)).toBeGreaterThanOrEqual(10);
    expect(validityRoundsFor(1)).toBeGreaterThanOrEqual(10);
  });

  it('clamps to the protocol maximum of 1000 rounds', () => {
    // An hour of TTL would want ~1240 rounds; the chain will not allow it.
    expect(validityRoundsFor(3_600_000)).toBe(1000);
    expect(validityRoundsFor(Number.MAX_SAFE_INTEGER)).toBe(1000);
  });

  it('grows with the TTL', () => {
    expect(validityRoundsFor(600_000)).toBeGreaterThan(validityRoundsFor(300_000));
  });

  it('outlasts the default that caused settlements to expire', () => {
    // The regression this guards: a 10-round (~29s) window cannot survive an
    // agent loop that takes minutes.
    expect(validityRoundsFor(300_000)).toBeGreaterThan(10 * 5);
  });
});
