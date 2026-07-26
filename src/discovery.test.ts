import { describe, expect, it } from 'vitest';

import {
  isAlgorandCaip2,
  merchantAcceptsAlgorand,
  toEndpointSummary,
  toMerchantSummary,
  toPriceSummary,
} from './discovery.js';

const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const BASE = 'eip155:8453';

describe('isAlgorandCaip2', () => {
  it('accepts Algorand CAIP-2 identifiers', () => {
    expect(isAlgorandCaip2(MAINNET)).toBe(true);
  });

  it('rejects other chains and missing values', () => {
    expect(isAlgorandCaip2(BASE)).toBe(false);
    expect(isAlgorandCaip2('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(false);
    expect(isAlgorandCaip2(undefined)).toBe(false);
  });
});

describe('toPriceSummary', () => {
  const requirements = {
    scheme: 'exact',
    network: MAINNET,
    asset: '31566704',
    amount: '10000',
    payTo: 'XJCCGGJ6FL6CFYNXCTO6Q5YQ7E2OIYVRX2G3BVZUF4JOL36HSJRPLYHW5E',
    maxTimeoutSeconds: 60,
    extra: { decimals: 6, feePayer: 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA' },
  } as never;

  it('renders atomic amounts using the declared decimals', () => {
    expect(toPriceSummary(requirements).amount_display).toBe('0.01');
  });

  it('surfaces the fee payer, which signals a gasless payment', () => {
    expect(toPriceSummary(requirements).fee_payer).toBe(
      'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA',
    );
  });

  it('labels the network for human display', () => {
    expect(toPriceSummary(requirements).network_label).toBe('Algorand MainNet');
  });

  it('omits the display amount when decimals are absent', () => {
    const noDecimals = { ...(requirements as object), extra: {} } as never;
    expect(toPriceSummary(noDecimals).amount_display).toBeUndefined();
  });

  it('trims trailing zeros but keeps whole amounts intact', () => {
    const whole = { ...(requirements as object), amount: '2000000' } as never;
    expect(toPriceSummary(whole).amount_display).toBe('2');
  });

  it('pads amounts smaller than one whole unit', () => {
    const dust = { ...(requirements as object), amount: '1' } as never;
    expect(toPriceSummary(dust).amount_display).toBe('0.000001');
  });
});

describe('toEndpointSummary', () => {
  it('drops non-Algorand payment options the server cannot pay', () => {
    const summary = toEndpointSummary({
      id: 'abc',
      resourceUrl: 'https://example.com/paid',
      accepts: [
        { scheme: 'exact', network: BASE, asset: '0xUSDC', amount: '10', payTo: '0xabc' },
        { scheme: 'exact', network: MAINNET, asset: '31566704', amount: '10', payTo: 'ALGO' },
      ],
    } as never);

    expect(summary.pricing).toHaveLength(1);
    expect(summary.pricing[0]?.network).toBe(MAINNET);
  });

  it('yields empty pricing for endpoints with no Algorand option', () => {
    const summary = toEndpointSummary({
      id: 'abc',
      resourceUrl: 'https://example.com/paid',
      accepts: [{ scheme: 'exact', network: BASE, asset: '0xUSDC', amount: '10', payTo: '0xabc' }],
    } as never);

    expect(summary.pricing).toEqual([]);
  });
});

describe('merchantAcceptsAlgorand', () => {
  it('matches on network list', () => {
    expect(merchantAcceptsAlgorand({ id: 'm', networks: [MAINNET] } as never)).toBe(true);
  });

  it('matches on an AVM address even when networks are absent', () => {
    expect(merchantAcceptsAlgorand({ id: 'm', addresses: { avm: 'ADDR' } } as never)).toBe(true);
  });

  it('rejects EVM-only merchants', () => {
    expect(
      merchantAcceptsAlgorand({ id: 'm', networks: [BASE], addresses: { evm: '0x' } } as never),
    ).toBe(false);
  });
});

describe('toMerchantSummary', () => {
  it('omits absent optional fields rather than emitting nulls', () => {
    const summary = toMerchantSummary({ id: 'm' } as never);
    expect(summary).toEqual({ merchant_id: 'm' });
    expect('name' in summary).toBe(false);
  });
});
