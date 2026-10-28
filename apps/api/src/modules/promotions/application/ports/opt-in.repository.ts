import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

export interface OptInRecord {
  readonly promotionId: Id<'Promotion'>;
  readonly sellerId: Id<'Seller'>;
  readonly optedInAt: Temporal.Instant;
  readonly withdrawnAt: Temporal.Instant | null;
}

/** A seller's opt-in to a co-funded campaign (`promotions.co_funding_opt_ins`). */
export interface OptInRepository {
  find(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    sellerId: Id<'Seller'>,
  ): Promise<OptInRecord | null>;
  /** Inserts the opt-in, or sets it again (clearing a withdrawal). */
  optIn(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void>;
  withdraw(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void>;
  /** Withdraws every live opt-in of the promotion; answers the sellers that were withdrawn. */
  withdrawAll(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<readonly Id<'Seller'>[]>;
  /** The sellers with a live (not withdrawn) opt-in, per promotion. */
  liveSellers(
    market: MarketContext,
    promotionIds: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, readonly Id<'Seller'>[]>>;
}

export const OPT_IN_REPOSITORY = Symbol('PROMOTIONS_OPT_IN_REPOSITORY');
