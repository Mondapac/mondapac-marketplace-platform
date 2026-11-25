import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  OfferPostReview,
  OfferPostReviewReason,
  OfferPostReviewStatus,
} from '../../domain/offer-post-review';
import type { QueueTextSearch } from './own-catalog.reader';

/** The filters of the post-publication review list (slice 6); absent means no filter. */
export interface OfferPostReviewFilter {
  /** Rows in this status; absent is every status (`all`). */
  readonly status?: OfferPostReviewStatus;
  /** Rows that carry any of these reasons. */
  readonly reasons?: readonly OfferPostReviewReason[];
  readonly sellerId?: Id<'Seller'>;
  /** Rows whose Offer's product has this platform category in its published revision. */
  readonly categoryId?: Id<'Category'>;
  /** Opened at or after (inclusive). */
  readonly openedFrom?: Temporal.Instant | null;
  /** Opened before (exclusive). */
  readonly openedTo?: Temporal.Instant | null;
  /** The review queue's text search: product code, published product name, or a matched store. */
  readonly search?: QueueTextSearch;
}

export interface OfferPostReviewPage {
  readonly sort: 'opened' | 'decided';
  readonly direction: 'asc' | 'desc';
  readonly offset: number;
  readonly limit: number;
}

/** One received reason (insert-only): the idempotency key of a referral or a sample. */
export interface OfferPostReviewReasonReceipt {
  readonly offerId: Id<'Offer'>;
  readonly reason: OfferPostReviewReason;
  /** A pricing record id, or `offer-version:<n>` for a sample. */
  readonly sourceRef: string;
  readonly postReviewId: Id<'OfferPostReview'>;
  readonly receivedAt: Temporal.Instant;
}

/**
 * The post-publication review rows (`catalog.offer_post_reviews`) and the reasons they received
 * (`catalog.offer_post_review_reasons`). Every statement takes the caller's Market and runs in the
 * caller's unit. Rows are never deleted. Lock order of a unit: the Offer row first, then this.
 */
export interface OfferPostReviewRepository {
  /**
   * Inserts a new open row; the partial unique refuses a second open one per Offer: then
   * `StaleAggregateError`, and the caller asks again.
   */
  insert(market: MarketContext, review: OfferPostReview): Promise<void>;

  /**
   * Stores a changed row read at `loadedVersion`: one `UPDATE ... WHERE id AND version`. False
   * when no row moved (another unit changed it first).
   */
  save(market: MarketContext, review: OfferPostReview): Promise<boolean>;

  /**
   * Records that a reason arrived from a source (`ON CONFLICT DO NOTHING` on (market, offer,
   * reason, source)). True when it is new; false when that source already gave it (a redelivery).
   */
  receive(market: MarketContext, receipt: OfferPostReviewReasonReceipt): Promise<boolean>;

  /** Whether (market, offer, reason, source) was received already. */
  received(
    market: MarketContext,
    key: Pick<OfferPostReviewReasonReceipt, 'offerId' | 'reason' | 'sourceRef'>,
  ): Promise<boolean>;

  findOpenByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<OfferPostReview | null>;

  /** The row in this Market, or null: another Market's id is not found. */
  findById(market: MarketContext, id: Id<'OfferPostReview'>): Promise<OfferPostReview | null>;

  /** Whether any row of the Offer was ever `taken-down` (the resubmit goes to R6). */
  everTakenDown(market: MarketContext, offerId: Id<'Offer'>): Promise<boolean>;

  list(
    market: MarketContext,
    page: OfferPostReviewPage,
    filter: OfferPostReviewFilter,
  ): Promise<readonly OfferPostReview[]>;

  count(market: MarketContext, filter: OfferPostReviewFilter): Promise<number>;

  /** The distinct sellers with a row in `status` (all when absent), at most `limit`, by id. */
  sellerIds(
    market: MarketContext,
    status: OfferPostReviewStatus | undefined,
    limit: number,
  ): Promise<readonly Id<'Seller'>[]>;

  /**
   * The accounts behind the Offer's submits (its `submitted` and `published` history rows: the
   * actor and, in an acting-as session, the admin behind it). An admin never decides a row of an
   * Offer their own account submitted (slice 2c rule).
   */
  submitterAccountIds(
    market: MarketContext,
    offerId: Id<'Offer'>,
  ): Promise<ReadonlySet<Id<'Account'>>>;
}
export const OFFER_POST_REVIEW_REPOSITORY = Symbol('CATALOG_OFFER_POST_REVIEW_REPOSITORY');

/**
 * The keyed draw of the post-publication sample (slice 6): a bucket of 0 to 9,999 from
 * HMAC-SHA-256 under a key derived from the catalog stack secret, over the Market, the Offer and
 * its version. Unpredictable from outside; the key is never a panel setting and never logged.
 */
export interface OfferPostReviewSampler {
  bucketOf(market: MarketContext, offerId: Id<'Offer'>, offerVersion: number): number;
}
export const OFFER_POST_REVIEW_SAMPLER = Symbol('CATALOG_OFFER_POST_REVIEW_SAMPLER');
