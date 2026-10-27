import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { HoldOrigin, HoldReason, ReleaseReason } from '../../domain/payout-hold';

export interface PayoutHoldRecord {
  readonly id: Id<'PayoutHold'>;
  readonly sellerId: Id<'Seller'>;
  /** Null = the whole seller. */
  readonly sellerOrderId: Id<'SellerOrder'> | null;
  readonly reason: HoldReason;
  readonly origin: HoldOrigin;
  readonly sourceRef: string;
  readonly placedBy: Id<'Account'> | null;
  readonly placedAt: Temporal.Instant;
  readonly releasedAt: Temporal.Instant | null;
  readonly releasedBy: Id<'Account'> | null;
  readonly releaseReason: ReleaseReason | null;
}

/**
 * The payout holds of one Market (`commission_payouts.payout_holds`): insert and release only. A
 * database trigger refuses every other UPDATE, a second release and every DELETE.
 */
export interface PayoutHoldRepository {
  /**
   * Inserts the hold unless one with the same reason and source exists (a repeated event); true
   * when it was inserted.
   */
  insertIfAbsent(market: MarketContext, hold: PayoutHoldRecord): Promise<boolean>;

  find(market: MarketContext, holdId: Id<'PayoutHold'>): Promise<PayoutHoldRecord | null>;

  /** Sets the release columns of an active hold; false when it is not active (or not there). */
  release(
    market: MarketContext,
    holdId: Id<'PayoutHold'>,
    release: {
      readonly releasedAt: Temporal.Instant;
      readonly releasedBy: Id<'Account'>;
      readonly reason: ReleaseReason;
    },
  ): Promise<boolean>;

  /** Every hold of one reason and source (a dispute's holds), newest first. */
  listBySource(
    market: MarketContext,
    reason: HoldReason,
    sourceRef: string,
  ): Promise<readonly PayoutHoldRecord[]>;

  /**
   * Releases every active hold of one reason and source, by the system or by `releasedBy`; answers
   * the holds it released.
   */
  releaseBySource(
    market: MarketContext,
    reason: HoldReason,
    sourceRef: string,
    release: {
      readonly releasedAt: Temporal.Instant;
      readonly releasedBy: Id<'Account'> | null;
      readonly reason: ReleaseReason;
    },
  ): Promise<readonly PayoutHoldRecord[]>;

  /** How many holds of this reason a seller order has ever had (the version of its event). */
  countForSellerOrder(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    reason: HoldReason,
  ): Promise<number>;

  /** The seller's holds, active first then newest first, at most `limit`. */
  listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    options: { readonly activeOnly: boolean; readonly limit: number },
  ): Promise<readonly PayoutHoldRecord[]>;
}

export const PAYOUT_HOLD_REPOSITORY = Symbol('PAYOUT_HOLD_REPOSITORY');
