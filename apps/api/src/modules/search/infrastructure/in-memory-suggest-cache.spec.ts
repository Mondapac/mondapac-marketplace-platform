import { Temporal } from '@mondapac/shared-kernel';
import type { Clock } from '@mondapac/shared-kernel';
import type { SuggestCandidates } from '../application/ports/suggest-cache';
import { InMemorySuggestCache } from './in-memory-suggest-cache';

const value = (total: number): SuggestCandidates => ({
  offers: [],
  total,
  totalIsCapped: false,
  stores: [],
});

class TestClock implements Clock {
  #ms = Date.parse('2026-11-11T10:00:00Z');
  now(): Temporal.Instant {
    return Temporal.Instant.fromEpochMilliseconds(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
}

describe('InMemorySuggestCache', () => {
  it('keeps an entry for the time to live and then forgets it', async () => {
    const clock = new TestClock();
    const cache = new InMemorySuggestCache(clock, 30_000, 10);
    await cache.set('AU|tea', value(3));

    clock.advance(29_999);
    expect(await cache.get('AU|tea')).toEqual(value(3));
    clock.advance(1);
    expect(await cache.get('AU|tea')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('keeps the Markets apart through the key and replaces a key', async () => {
    const cache = new InMemorySuggestCache(new TestClock(), 30_000, 10);
    await cache.set('AU|tea', value(1));
    await cache.set('ZZ|tea', value(2));
    await cache.set('AU|tea', value(3));

    expect((await cache.get('AU|tea'))?.total).toBe(3);
    expect((await cache.get('ZZ|tea'))?.total).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('never holds more than its bound: expired entries go first, then the oldest', async () => {
    const clock = new TestClock();
    const cache = new InMemorySuggestCache(clock, 30_000, 3);
    await cache.set('a', value(1));
    clock.advance(31_000);
    await cache.set('b', value(2));
    await cache.set('c', value(3));
    await cache.set('d', value(4));
    expect(cache.size).toBe(3);
    expect(await cache.get('a')).toBeUndefined();

    await cache.set('e', value(5));
    expect(cache.size).toBe(3);
    expect(await cache.get('b')).toBeUndefined();
    expect((await cache.get('e'))?.total).toBe(5);
  });
});
