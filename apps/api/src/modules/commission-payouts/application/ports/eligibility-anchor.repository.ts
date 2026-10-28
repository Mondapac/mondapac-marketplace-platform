import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AnchorSource } from '../../domain/payout-terms';

/** When a delivered seller order's money becomes eligible, frozen at the delivery. */
export interface EligibilityAnchor {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly sellerId: Id<'Seller'>;
  readonly deliveredAt: Temporal.Instant;
  readonly source: AnchorSource;
  /** The hold in force when the anchor was set (7 to 60). */
  readonly holdDaysApplied: number;
  readonly eligibleAt: Temporal.Instant;
  readonly recordedAt: Temporal.Instant;
}

/**
 * The eligibility anchors of one Market (`commission_payouts.eligibility_anchors`): written once.
 * The database refuses any UPDATE or DELETE of a row.
 */
export interface EligibilityAnchorRepository {
  /** Inserts the anchor unless the seller order has one; true when it was inserted. */
  insertIfAbsent(market: MarketContext, anchor: EligibilityAnchor): Promise<boolean>;

  find(market: MarketContext, sellerOrderId: Id<'SellerOrder'>): Promise<EligibilityAnchor | null>;

  /** The anchors of these seller orders; one without an anchor is left out. */
  findMany(
    market: MarketContext,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<readonly EligibilityAnchor[]>;
}

export const ELIGIBILITY_ANCHOR_REPOSITORY = Symbol('ELIGIBILITY_ANCHOR_REPOSITORY');
