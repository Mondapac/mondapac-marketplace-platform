import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

export type ReviewsFacadeFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  /** Reviews are off in this Market (the default until an admin switches them on). */
  | { readonly code: 'reviews.disabled' }
  /** The Market has no review settings or a read failed: callers fail closed. */
  | { readonly code: 'reviews.unavailable' };

/** The stars of a product, across sellers (owner decision N3). */
export interface ProductRatingSummary {
  readonly productId: Id<'Product'>;
  readonly count: number;
  /** Hundredths of a star (433 is 4.33); null while there is no review. */
  readonly averageTimes100: number | null;
  /** Reviews of 1, 2, 3, 4 and 5 stars. */
  readonly histogram: readonly [number, number, number, number, number];
  /** A product summary is shown from the first review. */
  readonly shown: boolean;
}

/** A seller's rated-order summary (owner decision N8): the web decides from `count`. */
export interface SellerRatingSummary {
  readonly sellerId: Id<'Seller'>;
  /** Rated seller orders. */
  readonly count: number;
  /** The Market's minimum of rated seller orders before the summary is meant to be shown. */
  readonly minimumCount: number;
  readonly meetsMinimum: boolean;
  readonly averageTimes100: number | null;
  readonly histogram: readonly [number, number, number, number, number];
  /** Shares in basis points (10000 is all); null while there is no rating. */
  readonly satisfiedBps: number | null;
  readonly asDescribedBps: number | null;
  readonly arrivedOkBps: number | null;
}

/**
 * The public facade of `reviews`. Every method takes the caller's `CallContext` first, unchanged,
 * and is a thin call of one use case, so the gate runs. Other modules inject
 * {@link REVIEWS_FACADE}; they never read reviews' tables. Every answer is `reviews.disabled`
 * while reviews are off in the Market, except `detachAuthor` (see there).
 */
export interface ReviewsFacade {
  /** The stars of a product (rule `anonymous`). In-process. */
  productSummary(
    context: CallContext,
    productId: Id<'Product'>,
  ): Promise<Result<ProductRatingSummary, ReviewsFacadeFailure>>;

  /** A seller's rated-order summary (rule `anonymous`). In-process. */
  sellerSummary(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<SellerRatingSummary, ReviewsFacadeFailure>>;

  /**
   * A deleted account's reviews and ratings lose their author link and stay as "Former
   * customer" (owner decision N11). Rule `system`; idempotent. It works whether reviews are on or
   * off: erasure does not wait for a switch. Identity's account deletion is not wired to it yet.
   */
  detachAuthor(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly reviews: number; readonly ratings: number }, ReviewsFacadeFailure>>;
}

/** Nest token of the {@link ReviewsFacade}, provided and exported by `ReviewsModule`. */
export const REVIEWS_FACADE = Symbol('REVIEWS_FACADE');
