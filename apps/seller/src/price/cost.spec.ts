import { describe, expect, it } from 'vitest';
import { costProblemOf, profitOf, savedCostsOf } from './cost.ts';

describe('profitOf (Offer page PR 7-UI)', () => {
  it('is You receive less the Cost, with its share of what the customer pays', () => {
    // The design example: receive 13.51, cost 9.00, customer pays 15.90: 4.51, 28%.
    expect(profitOf('1351', '900', '1590')).toEqual({ profitMinor: '451', percent: 28 });
  });

  it('rounds the share half away from zero and keeps a loss negative', () => {
    expect(profitOf('1050', '1000', '1000')).toEqual({ profitMinor: '50', percent: 5 });
    expect(profitOf('1005', '1000', '200')).toEqual({ profitMinor: '5', percent: 3 });
    expect(profitOf('800', '1000', '1000')).toEqual({ profitMinor: '-200', percent: -20 });
    expect(profitOf('1000', '1000', '1000')).toEqual({ profitMinor: '0', percent: 0 });
    // −2.5% rounds to −3; a loss under half a percent is 0, not −0; above 100% stays exact.
    expect(profitOf('975', '1000', '1000')).toEqual({ profitMinor: '-25', percent: -3 });
    expect(Object.is(profitOf('996', '1000', '1000')?.percent, 0)).toBe(true);
    expect(profitOf('3000', '500', '1000')).toEqual({ profitMinor: '2500', percent: 250 });
    expect(profitOf('900', '400', '1000')).toEqual({ profitMinor: '500', percent: 50 });
  });

  it('is exact for amounts beyond floating point', () => {
    expect(profitOf('9007199254740993', '1', null)).toEqual({
      profitMinor: '9007199254740992',
      percent: null,
    });
  });

  it('is null without both amounts, or with text that is not minor units', () => {
    expect(profitOf(null, '900', '1590')).toBeNull();
    expect(profitOf('1351', null, '1590')).toBeNull();
    expect(profitOf('13.51', '900', '1590')).toBeNull();
    expect(profitOf('1351', '-900', '1590')).toBeNull();
    expect(profitOf('1351', '900', '0')).toEqual({ profitMinor: '451', percent: null });
  });
});

describe('costProblemOf', () => {
  it('names each refusal of the Cost routes, and never the amount', () => {
    expect(costProblemOf({ status: 403, code: 'pricing.acting-as-refused' })).toBe('acting-as');
    expect(costProblemOf({ status: 403, code: 'access.denied' })).toBe('denied');
    expect(costProblemOf({ status: 409, code: 'conflict.stale' })).toBe('stale');
    expect(costProblemOf({ status: 409, code: 'pricing.series-retired' })).toBe('retired');
    expect(costProblemOf({ status: 422, code: 'pricing.amount-out-of-range' })).toBe(
      'out-of-range',
    );
    expect(costProblemOf({ status: 404, code: 'pricing.offer-not-found' })).toBe('not-found');
    expect(costProblemOf({ status: 429, code: 'request.throttled' })).toBe('throttled');
    expect(costProblemOf({ status: 503, code: 'access.unavailable' })).toBe('unavailable');
    expect(costProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(costProblemOf({ status: 500, code: 'internal' })).toBe('unknown');
  });
});

describe('savedCostsOf', () => {
  it('keeps the amount and version of each size the read answered for', () => {
    expect(
      savedCostsOf({
        offerId: 'o1',
        currency: 'AUD',
        variants: [
          { variantId: 'v1', seriesVersion: 2, cost: { amount: '900', currency: 'AUD' } },
          { variantId: 'v2', seriesVersion: null, cost: null },
        ],
      }),
    ).toEqual({
      v1: { amount: '900', seriesVersion: 2 },
      v2: { amount: null, seriesVersion: null },
    });
  });
});
