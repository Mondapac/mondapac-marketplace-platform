import { describe, expect, it } from 'vitest';
import {
  NO_LIVE_FILTERS,
  liveFilterCount,
  liveFiltersOf,
  livePriceBands,
  livePriceOf,
  minorPerMajor,
  withChoice,
  withLiveParams,
  withLivePrice,
} from '../src/catalog/live-filters.ts';

describe('live filters of a URL (attributes A7, variants V8)', () => {
  it('reads one filter per attribute, sorted, and drops malformed or repeated ones', () => {
    const filters = liveFiltersOf({
      filter: ['size:small,large,small', 'colour:red', 'size:medium', 'Bad:x', 'weight:', 'x:A'],
    });
    expect(filters.choices).toEqual([
      { attr: 'colour', values: ['red'] },
      { attr: 'size', values: ['large', 'small'] },
    ]);
    expect(liveFilterCount(filters)).toBe(3);
  });

  it('reads a price in minor units and leaves a sample band id alone', () => {
    expect(livePriceOf('1000..2500')).toEqual({ min: 1000, max: 2500 });
    expect(livePriceOf('..999')).toEqual({ min: null, max: 999 });
    expect(livePriceOf('10001..')).toEqual({ min: 10001, max: null });
    for (const bad of ['under-10', '..', '5..1', '1.5..2', '1..2..3', '99999999999999..'])
      expect(livePriceOf(bad)).toBeNull();
  });

  it('writes the filters after the query already on the address', () => {
    const filters = withLivePrice(
      withChoice(withChoice(NO_LIVE_FILTERS, 'size', 'small', true), 'colour', 'red', true),
      { min: null, max: 999 },
    );
    expect(withLiveParams('/c/lamb?direct=1', filters)).toBe(
      '/c/lamb?direct=1&filter=colour%3Ared&filter=size%3Asmall&price=..999',
    );
    expect(withLiveParams('/c/lamb', NO_LIVE_FILTERS)).toBe('/c/lamb');
    expect(withChoice(filters, 'size', 'small', false).choices).toEqual([
      { attr: 'colour', values: ['red'] },
    ]);
  });

  it('offers price bands in the minor units of each currency', () => {
    expect(minorPerMajor('AUD')).toBe(100);
    expect(minorPerMajor('JPY')).toBe(1);
    const aud = livePriceBands('AUD').map((b) => b.price);
    expect(aud).toEqual([
      { min: null, max: 999 },
      { min: 1000, max: 2500 },
      { min: 2500, max: 5000 },
      { min: 5000, max: 10000 },
      { min: 10001, max: null },
    ]);
    expect(livePriceBands('JPY')[0]?.price).toEqual({ min: null, max: 9 });
    expect(livePriceBands('NZD')[1]?.band).toEqual({
      id: '1000..2500',
      from: { amount: 1000, currency: 'NZD' },
      to: { amount: 2500, currency: 'NZD' },
    });
  });
});
