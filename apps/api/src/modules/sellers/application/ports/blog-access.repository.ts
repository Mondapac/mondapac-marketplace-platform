import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** The blog switch of a seller as the row holds it, after the row was locked by a version bump. */
export interface BlogAccessState {
  readonly enabled: boolean;
  /** The version of the admin settings row after this unit's bump (an outbox aggregate version). */
  readonly version: number;
}

/**
 * The write side of the blog switch in `sellers.seller_admin_settings` (blog package 1). Every
 * method runs inside the caller's read-write unit and is scoped by the Market.
 */
export interface BlogAccessRepository {
  /**
   * Locks the seller's setting row (it raises the row's version, which holds the row lock until
   * the unit ends) and returns the switch and the new version; null when the seller has no row.
   */
  lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<BlogAccessState | null>;

  /** Sets the switch with who and when; the row was locked by this unit. */
  set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly enabled: boolean;
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
    },
  ): Promise<void>;
}

export const BLOG_ACCESS_REPOSITORY = Symbol('BLOG_ACCESS_REPOSITORY');
