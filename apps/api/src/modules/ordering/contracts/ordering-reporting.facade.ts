import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** The most seller orders or refunds one facts call answers; more is refused. */
export const MAX_REPORT_FACTS = 100;
/** The most ids one page of changes holds. */
export const MAX_REPORT_CHANGES = 500;

export type ReportingReadFailure = AccessDenied | { readonly code: 'validation.failed' };

/** An amount with its tax in minor units: `amount` includes the tax. */
export interface ReportAmount {
  readonly amount: bigint;
  readonly tax: bigint;
}

/** One order line's goods as charged: after its discount, with its tax. */
export interface ReportLine {
  readonly offerId: Id<'Offer'>;
  readonly quantity: number;
  readonly goods: ReportAmount;
}

/**
 * One seller order as reporting records it (dashboards upgrade phase 3). Ids and money only: no
 * name, address, email or customer. `paidAt` is the order's confirmation (the event
 * `ordering.order-paid.v1`), `cancelledAt` the order's cancellation. `shippedOnTime` compares the
 * moment the seller handed the order over (ready, else shipped) with its ready-by promise: null
 * when it has no promise or is still within it unshipped, false once the promise passed without it.
 */
export interface SellerOrderReportFacts {
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly lines: readonly ReportLine[];
  /** The delivery the buyer paid, after its discount, with its tax. */
  readonly shipping: ReportAmount;
  readonly paidAt: Temporal.Instant | null;
  readonly cancelledAt: Temporal.Instant | null;
  readonly shippedAt: Temporal.Instant | null;
  readonly shippedOnTime: boolean | null;
  readonly deliveredAt: Temporal.Instant | null;
  /** The buyer's delivery method, chosen at checkout (dashboards v2). */
  readonly deliveryMethod: 'pickup' | 'instant' | 'same_day' | 'scheduled';
  /**
   * Shipping's id of the delivery quote charged (a plain id): null for a pickup and for a seller
   * order placed before quotes were kept (delivery models, package 5). Reporting asks shipping for
   * its region; ordering never hands over the ship-to address.
   */
  readonly deliveryQuoteId: string | null;
  /**
   * Whether the seller order was the buyer's first paid order in the Market, and the buyer's first
   * paid order with this seller (dashboards v2: new and returning customers), frozen when the
   * payment was confirmed. Both null when unknown: unpaid, or paid before ordering recorded them.
   * A first order is always the first with its seller. The buyer is never named.
   */
  readonly buyerFirstOrder: boolean | null;
  readonly buyerFirstWithSeller: boolean | null;
}

/** One goods line of a refund, with the Offer of the order line it refunds. */
export interface RefundReportLine {
  readonly offerId: Id<'Offer'>;
  readonly quantity: number;
  readonly goods: ReportAmount;
}

/** One SUCCEEDED refund, with positive totals; `refundedAt` is when Stripe confirmed it. */
export interface RefundReportFacts {
  readonly refundId: Id<'Refund'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly total: ReportAmount;
  readonly shipping: ReportAmount;
  readonly refundedAt: Temporal.Instant;
  readonly lines: readonly RefundReportLine[];
}

export interface SellerOrderRef {
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
}

/** A seller order to read, or (`sellerOrderId` null) every seller order of the order. */
export interface SellerOrderQuery {
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'> | null;
}

/** A half-open window `[from, to)`; `from` null means from the first record (the backfill). */
export interface ReportWindow {
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant;
}

export interface ReportChangesPage<T> {
  readonly items: readonly T[];
  /** The id to pass as `after` for the next page; null on the last page. */
  readonly next: string | null;
}

/**
 * What `reporting` may read of ordering (dashboards upgrade, option B, phase 3). Every method is
 * rule `system`: only reporting's worker, nightly reconcile and history backfill call it, as the
 * Market's system actor. Not exposed over HTTP.
 */
export interface OrderingReportingFacade {
  /**
   * The facts of each requested seller order (at most {@link MAX_REPORT_FACTS}). A seller order
   * that is unknown, of another Market or not of the named order is absent; a null seller order
   * asks for every seller order of the order. A line placed before
   * its tax was recorded counts with tax 0: no tax is guessed.
   */
  sellerOrderReportFacts(
    context: CallContext,
    request: { readonly sellerOrders: readonly SellerOrderQuery[] },
  ): Promise<Result<readonly SellerOrderReportFacts[], ReportingReadFailure>>;

  /** The facts of each requested refund that SUCCEEDED (at most {@link MAX_REPORT_FACTS}). */
  refundReportFacts(
    context: CallContext,
    request: { readonly refundIds: readonly Id<'Refund'>[] },
  ): Promise<Result<readonly RefundReportFacts[], ReportingReadFailure>>;

  /**
   * The seller orders whose payment, cancellation, ready, shipment or delivery falls in the
   * window, by seller order id after `after`, at most `limit` (1 to {@link MAX_REPORT_CHANGES}).
   */
  sellerOrdersChanged(
    context: CallContext,
    request: {
      readonly window: ReportWindow;
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<Result<ReportChangesPage<SellerOrderRef>, ReportingReadFailure>>;

  /** The refunds that succeeded in the window, by refund id after `after`, at most `limit`. */
  refundsSucceeded(
    context: CallContext,
    request: {
      readonly window: ReportWindow;
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<Result<ReportChangesPage<Id<'Refund'>>, ReportingReadFailure>>;
}

/** Nest token of the {@link OrderingReportingFacade}, provided and exported by `OrderingModule`. */
export const ORDERING_REPORTING_FACADE = Symbol('ORDERING_REPORTING_FACADE');
