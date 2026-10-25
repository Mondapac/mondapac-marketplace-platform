import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  ABOUT_CACHE_MAX_ENTRIES,
  ABOUT_CACHE_TTL_MS,
  PublishedAboutCache,
} from './published-about-cache';

// The bounded cache of decrypted public About texts (Hassan M5): 1000 entries, 10 minutes, the
// least recently used goes first, keyed by Market, seller and published revision.

const clock = new FixedClock(Temporal.Instant.from('2026-10-15T10:00:00Z'));
const seller = (n: number) => `seller-${n}` as Id<'Seller'>;
const revision = (n: number) => `revision-${n}` as Id<'StoreProfileRevision'>;
const key = (n: number, code = 'AU') =>
  PublishedAboutCache.keyOf(testMarketContext(code, 'default'), seller(n), revision(n));

describe('PublishedAboutCache', () => {
  it('is bounded at 1000 entries and 10 minutes, as designed', () => {
    expect(ABOUT_CACHE_MAX_ENTRIES).toBe(1000);
    expect(ABOUT_CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('keeps the Market, the seller and the revision in the key', () => {
    const market = testMarketContext('AU', 'default');
    const keys = new Set([
      PublishedAboutCache.keyOf(market, seller(1), revision(1)),
      PublishedAboutCache.keyOf(testMarketContext('ZZ', 'default'), seller(1), revision(1)),
      PublishedAboutCache.keyOf(market, seller(2), revision(1)),
      PublishedAboutCache.keyOf(market, seller(1), revision(2)),
    ]);

    expect(keys.size).toBe(4);
  });

  it('answers undefined for an unknown key, the text for a known one, and null for "no text"', () => {
    const cache = new PublishedAboutCache(clock);
    cache.set(key(1), 'About one');
    cache.set(key(2), null);

    expect(cache.get(key(1))).toBe('About one');
    expect(cache.get(key(2))).toBeNull();
    expect(cache.get(key(3))).toBeUndefined();
  });

  it('drops an entry after the TTL', () => {
    const time = new FixedClock(Temporal.Instant.from('2026-10-15T10:00:00Z'));
    const cache = new PublishedAboutCache(time);
    cache.set(key(1), 'text');

    time.advance(Temporal.Duration.from({ minutes: 9, seconds: 59 }));
    expect(cache.get(key(1))).toBe('text');
    time.advance(Temporal.Duration.from({ seconds: 1 }));
    expect(cache.get(key(1))).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry once full, and a read counts as a use', () => {
    const cache = new PublishedAboutCache(clock, 3);
    cache.set(key(1), 'one');
    cache.set(key(2), 'two');
    cache.set(key(3), 'three');
    expect(cache.get(key(1))).toBe('one');

    cache.set(key(4), 'four');

    expect(cache.size).toBe(3);
    expect(cache.get(key(2))).toBeUndefined();
    expect(cache.get(key(1))).toBe('one');
    expect(cache.get(key(3))).toBe('three');
    expect(cache.get(key(4))).toBe('four');
  });

  it('never grows past its bound however many stores are read', () => {
    const cache = new PublishedAboutCache(clock);
    for (let n = 0; n < ABOUT_CACHE_MAX_ENTRIES + 250; n += 1) cache.set(key(n), `text ${n}`);

    expect(cache.size).toBe(ABOUT_CACHE_MAX_ENTRIES);
    expect(cache.get(key(0))).toBeUndefined();
    expect(cache.get(key(ABOUT_CACHE_MAX_ENTRIES + 249))).toBe(
      `text ${ABOUT_CACHE_MAX_ENTRIES + 249}`,
    );
  });
});
