import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PayoutTermsOverride } from '../../domain/payout-terms';

/** A seller's own payout terms as stored. */
export interface PayoutTermsOverrideRecord {
  readonly sellerId: Id<'Seller'>;
  readonly override: PayoutTermsOverride;
  /** Starts at 1; every change adds one. The optimistic-concurrency token of an admin edit. */
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
}

/**
 * The sellers' own payout terms of one Market (`commission_payouts.payout_terms_overrides`). A
 * seller without a row is on the Market's terms. Every method runs inside the caller's unit of work
 * and is scoped by the Market.
 */
export interface PayoutTermsRepository {
  find(market: MarketContext, sellerId: Id<'Seller'>): Promise<PayoutTermsOverrideRecord | null>;

  /** Creates the row; false when the seller already has one (a concurrent first write). */
  insert(market: MarketContext, record: PayoutTermsOverrideRecord): Promise<boolean>;

  /**
   * Replaces the row's values and sets `record.version`, only while the stored version is
   * `expectedVersion`; false when it is not (another admin wrote first, or the row is gone).
   */
  replace(
    market: MarketContext,
    record: PayoutTermsOverrideRecord,
    expectedVersion: number,
  ): Promise<boolean>;

  /** Removes the row, only while the stored version is `expectedVersion`; false otherwise. */
  remove(market: MarketContext, sellerId: Id<'Seller'>, expectedVersion: number): Promise<boolean>;
}

export const PAYOUT_TERMS_REPOSITORY = Symbol('PAYOUT_TERMS_REPOSITORY');
