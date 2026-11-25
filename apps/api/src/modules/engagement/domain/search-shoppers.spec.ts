import type { Id } from '@mondapac/shared-kernel';
import { MIN_SEARCH_SHOPPERS, searchKeyOf, searchShoppersOf } from './search-shoppers';

const account = (n: number) =>
  `01990000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<'Account'>;
const pairs = (query: string, accounts: number, eventsEach = 1) =>
  Array.from({ length: accounts }, (_, n) => ({
    query,
    accountId: account(n + 1),
    events: eventsEach,
  }));

describe('searchKeyOf: the key of a stored search text', () => {
  it('lowers the case of the normalized text, locale-free', () => {
    expect(searchKeyOf('Halal LAMB')).toBe('halal lamb');
    expect(searchKeyOf('نان سنگک')).toBe('نان سنگک');
  });
});

describe('searchShoppersOf: distinct signed-in searchers per asked key', () => {
  const keys = new Set(['halal lamb', 'barberry']);

  it('counts each account once per key across case variants, and every search', () => {
    const rows = [
      ...pairs('halal lamb', MIN_SEARCH_SHOPPERS, 2),
      // The same accounts typing it in another case are the same searchers.
      ...pairs('Halal Lamb', MIN_SEARCH_SHOPPERS),
    ];
    expect(searchShoppersOf(rows, keys)).toEqual([
      { query: 'halal lamb', shoppers: MIN_SEARCH_SHOPPERS, searches: 3 * MIN_SEARCH_SHOPPERS },
    ]);
  });

  it('answers nothing about a key with fewer than the minimum searchers', () => {
    expect(searchShoppersOf(pairs('barberry', MIN_SEARCH_SHOPPERS - 1, 50), keys)).toEqual([]);
    expect(MIN_SEARCH_SHOPPERS).toBe(10);
  });

  it('never answers a text that was not asked', () => {
    expect(searchShoppersOf(pairs('sumac', 40), keys)).toEqual([]);
  });

  it('orders by searches, then by text', () => {
    const rows = [...pairs('barberry', 12), ...pairs('halal lamb', 11, 3)];
    expect(searchShoppersOf(rows, keys).map((row) => row.query)).toEqual([
      'halal lamb',
      'barberry',
    ]);
    const tie = [...pairs('barberry', 10), ...pairs('halal lamb', 10)];
    expect(searchShoppersOf(tie, keys).map((row) => row.query)).toEqual(['barberry', 'halal lamb']);
  });
});
