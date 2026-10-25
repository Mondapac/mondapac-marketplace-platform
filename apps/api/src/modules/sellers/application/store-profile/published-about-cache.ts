import type { Clock, Id, MarketContext } from '@mondapac/shared-kernel';

/** Entries one process keeps: about one store page's About text each. */
export const ABOUT_CACHE_MAX_ENTRIES = 1000;
/** How long an entry is reused, in milliseconds (10 minutes). */
export const ABOUT_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * The decrypted public About texts, kept in this process only (sellers design 8.1, 16.2 item 7;
 * Hassan M5). The key is the Market, the seller and the published revision id, so:
 *
 * - the published pointer is read in clear on every call and a new save names a new revision id,
 *   which no entry has: a save is visible at once, and the old entry is never asked for again;
 * - a revision is insert-only, so an entry is never stale for its key; the TTL only bounds how
 *   long decrypted text outlives its need (and how long it outlives an erasure);
 * - a miss costs one key unwrap (the caller decrypts and stores the answer);
 * - the least recently used entry goes first once there are {@link ABOUT_CACHE_MAX_ENTRIES}.
 *
 * It holds the text a buyer can read anyway, never a key, never a ciphertext. `null` is cached
 * too: a published revision with no text for the Market's default locale.
 */
export class PublishedAboutCache {
  readonly #entries = new Map<string, { readonly text: string | null; readonly at: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly maxEntries: number = ABOUT_CACHE_MAX_ENTRIES,
    private readonly ttlMs: number = ABOUT_CACHE_TTL_MS,
  ) {}

  static keyOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'StoreProfileRevision'>,
  ): string {
    return `${market.marketId}|${sellerId}|${revisionId}`;
  }

  /** The cached text (possibly `null`), or `undefined` when there is no live entry. */
  get(key: string): string | null | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const age = this.clock.now().epochMilliseconds - entry.at;
    if (age < 0 || age >= this.ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    // Most recently used goes last.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.text;
  }

  set(key: string, text: string | null): void {
    this.#entries.delete(key);
    this.#entries.set(key, { text, at: this.clock.now().epochMilliseconds });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
