import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/**
 * Which tags a certification event selects (design 5.5), always among the tags that are not
 * removed and whose copy names a revision that was published at its decision (5.1a point 5;
 * `copy_revision_published`): `certificate` the copy's certificate id (expired, revoked);
 * `certificate-version` the copy's submission (issuer confirmed); `seller` the Offer's seller
 * (seller certification approved: the event names a type id, which catalog does not store, so
 * every tag of the seller is re-asked; a superset that only costs asks).
 */
export type TagSelection =
  | { readonly by: 'certificate'; readonly id: Id }
  | { readonly by: 'certificate-version'; readonly id: Id }
  | { readonly by: 'seller'; readonly id: Id };

/** One tag of the reconciliation order (design 5.6): its Offer and the instant of its last ask. */
export interface StaleTag {
  readonly tagId: Id<'OfferTag'>;
  readonly offerId: Id<'Offer'>;
  readonly evaluatedAt: Temporal.Instant;
}

/**
 * The reads that select tags to ask again (data design 3.15 selection and reconciliation
 * indexes). Catalog's own rows only; every statement carries `market_id`. In the caller's unit.
 */
export interface TagSelectionReader {
  /**
   * The ids of the Offers that hold a selected tag, ascending, after `afterId` (null for the
   * first page), at most `limit`.
   */
  selectedOffers(
    market: MarketContext,
    selection: TagSelection,
    page: { readonly afterId: Id<'Offer'> | null; readonly limit: number },
  ): Promise<readonly Id<'Offer'>[]>;

  /**
   * The reconciliation order (design 5.6): `active`, `rechecking` and `suspended` tags whose
   * last ask is before `before`, oldest ask first (then by id), after the position `after`, at
   * most `limit`. Only tags whose copy names a revision that has a `published` decision (data
   * design 3.15: joined, not the flag), so tags of a never-published revision are excluded (5.1a
   * point 5).
   */
  staleTags(
    market: MarketContext,
    page: {
      readonly before: Temporal.Instant;
      readonly after: { readonly evaluatedAt: Temporal.Instant; readonly tagId: Id } | null;
      readonly limit: number;
    },
  ): Promise<readonly StaleTag[]>;
}

export const TAG_SELECTION_READER = Symbol('TAG_SELECTION_READER');
