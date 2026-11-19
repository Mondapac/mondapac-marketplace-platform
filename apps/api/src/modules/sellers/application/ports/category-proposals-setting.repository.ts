import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The category-proposals switch of a seller (SEL-26) as the row holds it, after the row was
 * locked by a version bump.
 */
export interface CategoryProposalsSettingState {
  readonly allowed: boolean;
  /** The version of the admin settings row after this unit's bump (an outbox aggregate version). */
  readonly version: number;
}

/**
 * The write side of `category_proposals_allowed` in `sellers.seller_admin_settings` (SEL-26).
 * Every method runs inside the caller's read-write unit and is scoped by the Market.
 */
export interface CategoryProposalsSettingRepository {
  /**
   * Locks the seller's setting row (it raises the row's version, which holds the row lock until
   * the unit ends) and returns the switch and the new version; null when the seller has no row in
   * the Market (an unknown seller and another Market's seller alike).
   */
  lock(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<CategoryProposalsSettingState | null>;

  /** Sets the switch with who and when; the row was locked by this unit. */
  set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly allowed: boolean;
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
    },
  ): Promise<void>;
}

export const CATEGORY_PROPOSALS_SETTING_REPOSITORY = Symbol(
  'CATEGORY_PROPOSALS_SETTING_REPOSITORY',
);
