import type { Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import type { WorkQueuePanel } from './work-queue-source';

/** How long one queue's count is reused (design section 6: 60 seconds). */
export const WORK_QUEUE_CACHE_TTL_MS = 60_000;

/** The most answers kept; the oldest goes first. */
export const WORK_QUEUE_CACHE_MAX_ENTRIES = 2_000;

/**
 * What a cached count depends on (design section 6, Mohammad): the Market and tenant, the panel,
 * the viewer's whole permission set (sorted) and, on the seller panel, the seller. Two viewers
 * share an answer only when they could each read exactly the same queues, so no count reaches a
 * viewer without the key behind it.
 */
export interface WorkQueueCacheKey {
  readonly marketId: string;
  readonly tenantId: string;
  readonly panel: WorkQueuePanel;
  readonly permissionKeys: readonly string[];
  readonly sellerId: string | null;
  readonly queue: string;
}

/** A kept count and when it was counted (the card shows its age). */
export interface CachedCount {
  readonly count: WorkQueueCount;
  readonly countedAt: Temporal.Instant;
}

const keyOf = (key: WorkQueueCacheKey): string =>
  JSON.stringify([
    key.marketId,
    key.tenantId,
    key.panel,
    [...key.permissionKeys].sort(),
    key.sellerId,
    key.queue,
  ]);

/**
 * The counts of the work queue, in this process, for {@link WORK_QUEUE_CACHE_TTL_MS}. Bounded at
 * {@link WORK_QUEUE_CACHE_MAX_ENTRIES}. Only a count the owner answered in time is kept; a
 * refusal, a failure or a timeout is not, so the next read asks again. A `live` queue is never
 * put here. Time comes from the injected Clock.
 */
export class WorkQueueCache {
  readonly #entries = new Map<string, CachedCount & { readonly expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = WORK_QUEUE_CACHE_TTL_MS,
    private readonly maxEntries: number = WORK_QUEUE_CACHE_MAX_ENTRIES,
  ) {}

  /** The kept count, or undefined when there is none or it has expired. */
  get(key: WorkQueueCacheKey, now: Temporal.Instant): CachedCount | undefined {
    const id = keyOf(key);
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    if (now.epochMilliseconds >= entry.expiresAt) {
      this.#entries.delete(id);
      return undefined;
    }
    return { count: entry.count, countedAt: entry.countedAt };
  }

  set(key: WorkQueueCacheKey, count: WorkQueueCount, now: Temporal.Instant): void {
    const id = keyOf(key);
    this.#entries.delete(id);
    this.#entries.set(id, { count, countedAt: now, expiresAt: now.epochMilliseconds + this.ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
