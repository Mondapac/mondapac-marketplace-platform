import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { StoredRevision } from '../../domain/stored-revision';

/**
 * The store of product revisions (catalog data design 3.7 to 3.10). Every method runs in the open
 * unit of the caller, through the Market-scoped client. Revisions are insert-only: there is no
 * update and no delete. `field_provenance` (D 13.1) is not carried yet: it arrives with the first
 * AI-assisted draft slice, and the column stays NULL until then.
 */
export interface ProductRevisionRepository extends ProductRevisionDecisions {
  /**
   * The number the next revision of the product takes: one more than the highest, or 1. Only a
   * hint: two concurrent units can read the same number, and the unique key on (product,
   * number) fails the second `add`, which the caller maps to a stale conflict and retries.
   */
  nextRevisionNo(market: MarketContext, productId: Id<'Product'>): Promise<number>;

  /**
   * Writes the revision row with its texts, categories, variants and ordered images. The database
   * refuses an image of another product or one that is not clean, a variant of another product
   * or a retired one, a category of another Market, a repeated option key.
   */
  add(market: MarketContext, revision: StoredRevision): Promise<void>;

  /** The revision of this product in this Market, or null (also for another product's id). */
  find(
    market: MarketContext,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
  ): Promise<StoredRevision | null>;
}

/** A reviewer's decision on a pending revision, as the decision row keeps it (data design 3.12). */
export interface ReviewDecision {
  readonly revisionId: Id<'ProductRevision'>;
  readonly outcome: 'published' | 'changes-requested';
  /** The reason code of a changes request; null for an approval. */
  readonly reasonCode: string | null;
  /** The checks the server derived for the revision (design 8.3a). */
  readonly requiredChecks: readonly string[];
  /** The checks the reviewer confirmed; an approval holds every required one. */
  readonly confirmedChecks: readonly string[];
  readonly decidedByAccountId: Id<'Account'>;
  /** The product version the reviewer saw. */
  readonly productVersion: number;
  readonly decidedAt: Temporal.Instant;
}

/** The last change request on a product, while it is still the product's latest revision. */
export interface ChangeRequestView {
  readonly revisionId: Id<'ProductRevision'>;
  readonly revisionNo: number;
  readonly reasonCode: string;
  readonly decidedAt: Temporal.Instant;
}

export interface ProductRevisionDecisions {
  /**
   * Stores the decision of a reviewer (`published`/`reviewed` or `changes-requested`) in the open
   * unit. One outcome per revision: a second decision on the same revision fails on the key.
   */
  recordDecision(market: MarketContext, decision: ReviewDecision): Promise<void>;

  /**
   * The change request on the product's newest revision, or null when that revision has no
   * request (a newer submit, an approval, or none ever). The seller sees it until they resubmit.
   */
  latestChangeRequest(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<ChangeRequestView | null>;
}

export const PRODUCT_REVISION_REPOSITORY = Symbol('PRODUCT_REVISION_REPOSITORY');
