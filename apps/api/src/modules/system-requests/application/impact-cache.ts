import type { Temporal } from '@mondapac/shared-kernel';
import type { ChangeImpact } from '../../../platform/change-review/change-review';

/** How long one impact answer is reused (Hassan L2, Sajad 1 on PR #1146). */
export const IMPACT_CACHE_TTL_MS = 30_000;

/** The most answers kept; the oldest goes first. */
export const IMPACT_CACHE_MAX_ENTRIES = 500;

/**
 * What an impact answer depends on: the Market, the request and its state (status and the
 * request that superseded it; the values of a request never change), and the viewer (each module
 * counts only behind the viewer's own read keys, so another viewer may get none).
 */
export interface ImpactCacheKey {
  readonly marketId: string;
  readonly requestId: string;
  readonly status: string;
  readonly supersededBy: string | null;
  readonly viewerId: string;
}

const keyOf = (key: ImpactCacheKey): string =>
  JSON.stringify([key.marketId, key.requestId, key.status, key.supersededBy, key.viewerId]);

/**
 * The impact answers of the request detail, in this process, for {@link IMPACT_CACHE_TTL_MS}, so
 * reopening a request does not count again. Bounded at {@link IMPACT_CACHE_MAX_ENTRIES}. Only an
 * answer the module gave in time is kept (a null answer too); a timeout or a failure is not, so
 * the next open asks again. Time comes from the injected Clock.
 */
export class ImpactCache {
  readonly #entries = new Map<
    string,
    { readonly impact: ChangeImpact | null; readonly expiresAt: number }
  >();

  constructor(
    private readonly ttlMs: number = IMPACT_CACHE_TTL_MS,
    private readonly maxEntries: number = IMPACT_CACHE_MAX_ENTRIES,
  ) {}

  /** The kept answer, or undefined when there is none or it has expired. */
  get(key: ImpactCacheKey, now: Temporal.Instant): ChangeImpact | null | undefined {
    const id = keyOf(key);
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    if (now.epochMilliseconds >= entry.expiresAt) {
      this.#entries.delete(id);
      return undefined;
    }
    return entry.impact;
  }

  set(key: ImpactCacheKey, impact: ChangeImpact | null, now: Temporal.Instant): void {
    const id = keyOf(key);
    this.#entries.delete(id);
    this.#entries.set(id, { impact, expiresAt: now.epochMilliseconds + this.ttlMs });
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
