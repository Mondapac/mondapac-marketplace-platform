import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

export type CommissionPayoutsFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** The Market has no commission settings or the read failed: callers fail closed. */
  | { readonly code: 'commission-payouts.rate-unavailable' }
  /** The seller order's ledger rows are missing or do not fit the refund: nothing is posted. */
  | { readonly code: 'commission-payouts.ledger-inconsistent' }
  /**
   * The Market has no usable payout terms (none configured, or a stored value outside the hold
   * bounds): nothing is anchored and the caller tries again later.
   */
  | { readonly code: 'commission-payouts.terms-unavailable' };

/** The rate in force for a seller now: its own rate if an admin set one, else the Market's. */
export interface CommissionRate {
  readonly rateBps: number;
  readonly source: 'seller' | 'market';
}

/** The rate of every requested seller (each requested seller is present). */
export type CommissionRateMap = ReadonlyMap<Id<'Seller'>, CommissionRate>;

/** One paid line of a seller order, with the rate ordering froze on it at placement. */
export interface PaidLine {
  readonly orderLineId: Id<'OrderLine'>;
  /** Unit price × quantity after discounts, in minor units of the order currency. */
  readonly lineAmount: bigint;
  readonly taxInclusive: boolean;
  readonly commissionRateBps: number;
}

/** The facts of one paid seller order, as ordering stored them. */
export interface PaidSellerOrder {
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  /** The seller's flat delivery fee on this seller order (it is the seller's money). */
  readonly shipping: bigint;
  readonly paidAt: Temporal.Instant;
  readonly lines: readonly PaidLine[];
}

/** Who bears the loss of a refund (ordering's closed list). */
export type RefundLossBearer = 'seller' | 'platform';

/** The units of one order line a refund gives back, with the line's refunds before it. */
export interface RefundedLine {
  readonly orderLineId: Id<'OrderLine'>;
  /** The order line's own quantity. */
  readonly lineQuantity: number;
  /** Units of the line refunded by earlier refunds that had not failed. */
  readonly unitsBefore: number;
  /** Units this refund gives back (1 up to what is left). */
  readonly units: number;
}

/** The shipping part of a refund, as cumulative amounts of the shipping charge. */
export interface RefundedShipping {
  /** The shipping charge refunded by earlier refunds that had not failed (tax included). */
  readonly refundedBefore: bigint;
  /** The same after this refund (above `refundedBefore`). */
  readonly refundedAfter: bigint;
  /**
   * What the customer paid for delivery on the seller order, tax included: the whole that
   * `refundedAfter` runs up to. The ledger's `shipping` row is reversed in this proportion.
   */
  readonly charge: bigint;
}

/**
 * The facts of one succeeded refund, as ordering stored them: ids, numbers and the loss bearer. No
 * price: every amount is worked out from the ledger rows of the seller order.
 */
export interface RefundedSellerOrder {
  readonly refundId: Id<'Refund'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly lossBearer: RefundLossBearer;
  /** When Stripe confirmed the refund. */
  readonly settledAt: Temporal.Instant;
  readonly lines: readonly RefundedLine[];
  readonly shipping: RefundedShipping | null;
}

/** Who confirmed a delivery: the carrier's booking reached `delivered`, or the seller clicked. */
export type DeliverySource = 'carrier' | 'seller-click';

/**
 * The delivery of one seller order, as ordering stored it (package 6b). `source` is `carrier` when
 * the seller order's carrier booking reached progress `delivered`; every other delivery (the
 * seller's click, a pickup handover) is `seller-click`.
 */
export interface SellerOrderDelivered {
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly deliveredAt: Temporal.Instant;
  readonly source: DeliverySource;
}

/**
 * What `ordering` calls. Each method takes the caller's `CallContext` unchanged and is not
 * exposed over HTTP.
 */
export interface CommissionPayoutsFacade {
  /**
   * The commission rate in force for each seller (at most 100 distinct ids), for ordering to
   * freeze on the order lines at checkout. Any failure fails the whole call (fail closed).
   */
  commissionRates(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<CommissionRateMap, CommissionPayoutsFailure>>;

  /**
   * Writes the ledger rows of a paid seller order (system actor only). Idempotent: a seller order
   * already in the ledger writes nothing and answers `already-recorded`.
   */
  recordSellerOrderPaid(
    context: CallContext,
    paid: PaidSellerOrder,
  ): Promise<Result<'recorded' | 'already-recorded', CommissionPayoutsFailure>>;

  /**
   * Writes the ledger reversal rows of a succeeded refund (system actor only), in one unit. When
   * the platform bears the loss, or the refund reverses nothing, no row is written
   * (`nothing-to-post`). Idempotent: a refund already in the ledger writes nothing and answers
   * `already-recorded`.
   */
  recordRefund(
    context: CallContext,
    refund: RefundedSellerOrder,
  ): Promise<Result<'recorded' | 'already-recorded' | 'nothing-to-post', CommissionPayoutsFailure>>;

  /**
   * Freezes the eligibility anchor of a delivered seller order (system actor only): the delivery
   * instant plus the hold days of the seller's effective payout terms (carrier hold or
   * seller-click hold by `source`). Set once and idempotent: a seller order already anchored
   * changes nothing and answers `already-anchored`.
   */
  recordSellerOrderDelivered(
    context: CallContext,
    delivered: SellerOrderDelivered,
  ): Promise<Result<'anchored' | 'already-anchored', CommissionPayoutsFailure>>;
}

/** Nest token of the {@link CommissionPayoutsFacade}, provided by `CommissionPayoutsModule`. */
export const COMMISSION_PAYOUTS_FACADE = Symbol('COMMISSION_PAYOUTS_FACADE');
