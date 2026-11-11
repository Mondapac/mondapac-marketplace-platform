import type { Clock } from '@mondapac/shared-kernel';
import type { SuggestCache, SuggestCandidates } from '../application/ports/suggest-cache';

/** The suggest cache holds an answer for this long. */
export const SUGGEST_CACHE_TTL_MS = 30_000;
/** The most entries the in-process suggest cache keeps (a few thousand short queries). */
export const SUGGEST_CACHE_MAX_ENTRIES = 3000;

interface Entry {
  readonly value: SuggestCandidates;
  readonly expiresAt: number;
}

/**
 * {@link SuggestCache} in the process memory: a bounded map with a time to live. An expired entry
 * is dropped when read; when the map is full the oldest entry is evicted (a `Map` keeps insertion
 * order, and every entry has the same time to live, so the oldest is the first to expire). Each process has its own cache: a short life makes that harmless.
 */
export class InMemorySuggestCache implements SuggestCache {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number = SUGGEST_CACHE_TTL_MS,
    private readonly maxEntries: number = SUGGEST_CACHE_MAX_ENTRIES,
  ) {}

  #nowMs(): number {
    return this.clock.now().epochMilliseconds;
  }

  get(key: string): Promise<SuggestCandidates | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (entry.expiresAt <= this.#nowMs()) {
      this.#entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: SuggestCandidates): Promise<void> {
    const now = this.#nowMs();
    this.#entries.delete(key);
    // Every entry lives the same time, so insertion order is expiry order: the oldest goes first.
    while (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { value, expiresAt: now + this.ttlMs });
    return Promise.resolve();
  }

  /** The number of entries held (tests). */
  get size(): number {
    return this.#entries.size;
  }
}
