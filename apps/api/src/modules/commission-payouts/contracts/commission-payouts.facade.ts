import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

export type CommissionPayoutsFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** The Market has no commission settings or the read failed: callers fail closed. */
  | { readonly code: 'commission-payouts.rate-unavailable' };

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
}

/** Nest token of the {@link CommissionPayoutsFacade}, provided by `CommissionPayoutsModule`. */
export const COMMISSION_PAYOUTS_FACADE = Symbol('COMMISSION_PAYOUTS_FACADE');
