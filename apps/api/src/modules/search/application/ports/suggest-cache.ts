import type { SuggestOfferHit, SuggestStoreHit } from './suggest.reader';

/**
 * What the index said for one query, before catalog and sellers re-check it: the Offer candidates in
 * order, the product total of the scope and the store candidates with their Offer counts. Nothing
 * here is shown without the live check, so a cached entry can only be stale in its order or its
 * counts, never make a hidden product visible.
 */
export interface SuggestCandidates {
  readonly offers: readonly SuggestOfferHit[];
  /** Products in the scope (one per product); a lower bound when `totalIsCapped`. */
  readonly total: number;
  readonly totalIsCapped: boolean;
  readonly stores: readonly { readonly hit: SuggestStoreHit; readonly productCount: number }[];
}

/**
 * A short-lived cache of {@link SuggestCandidates}, keyed by Market and normalised query (the key is
 * made by the use case). The in-process adapter is the only one today (there is no Redis client in
 * the platform yet); a shared cache would be another adapter behind this port. A cache that fails
 * must not fail the request: an adapter answers `undefined` and ignores a failed write.
 */
export interface SuggestCache {
  get(key: string): Promise<SuggestCandidates | undefined>;
  set(key: string, value: SuggestCandidates): Promise<void>;
}

export const SUGGEST_CACHE = Symbol('SUGGEST_CACHE');
