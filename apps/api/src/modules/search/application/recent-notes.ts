/**
 * A small bounded set of recently written keys, least recently used dropped first (Mojtaba L1 of
 * PR 1342): the zero-result note skips the database for a (Market, quarter hour, text) it already
 * wrote. Best effort and per process: a restart, another process or an evicted key only costs one
 * more insert, which the table's ON CONFLICT DO NOTHING absorbs.
 */
export class RecentNotes {
  readonly #keys = new Map<string, true>();

  constructor(private readonly capacity: number) {}

  /** Whether the key was written recently; a hit becomes the most recent. */
  has(key: string): boolean {
    if (!this.#keys.has(key)) return false;
    this.#keys.delete(key);
    this.#keys.set(key, true);
    return true;
  }

  /** Remembers a key, dropping the least recently used one beyond the capacity. */
  add(key: string): void {
    this.#keys.delete(key);
    this.#keys.set(key, true);
    while (this.#keys.size > this.capacity) {
      const oldest = this.#keys.keys().next().value;
      if (oldest === undefined) break;
      this.#keys.delete(oldest);
    }
  }

  get size(): number {
    return this.#keys.size;
  }
}
