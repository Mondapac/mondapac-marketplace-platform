import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** A payment the provider holds on a card, as the webhook receiver reports it. */
export interface AuthorisedPayment {
  readonly orderId: string;
  readonly paymentIntentId: string;
  /** The Checkout session that created the payment; it must be the one stored on the order. */
  readonly sessionId: string;
  /** What the provider holds; it must equal the order total or the payment is voided. */
  readonly amount: Money;
}

export type PaymentFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  | { readonly code: 'ordering.order-not-found' }
  /** A temporary fault: handle the same event again later. */
  | { readonly code: 'ordering.try-again' };

/**
 * What the order emails need from a paid order (Phase 6 package 1): ids, quantities and the
 * currency. No customer name, address, email or amount. The customer's account id is for the
 * address lookup in `identity` only.
 */
export interface OrderNotice {
  readonly orderId: string;
  readonly accountId: Id<'Account'>;
  readonly sellerOrders: readonly {
    readonly sellerOrderId: Id<'SellerOrder'>;
    readonly sellerId: Id<'Seller'>;
    readonly lines: readonly {
      readonly offerId: Id<'Offer'>;
      readonly quantity: number;
    }[];
  }[];
}

/** `null` in the success case is not used: an unknown or unpaid order is `ordering.order-not-found`. */
export type OrderNoticeFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  | { readonly code: 'ordering.order-not-found' };

/**
 * What the "Shipped" email needs from a shipped seller order: the customer's account id (for the
 * address lookup in `identity` only), the carrier and the tracking number the seller typed in.
 */
export interface ShipmentNotice {
  readonly orderId: string;
  readonly accountId: Id<'Account'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly carrier: string;
  readonly trackingRef: string | null;
}

/** An unknown, foreign-Market, unpaid or not yet shipped seller order is `ordering.order-not-found`. */
export type ShipmentNoticeFailure = OrderNoticeFailure;

/**
 * The short customer name of one of the seller's own paid seller orders (in-app notices). PERSONAL
 * DATA for the seller member who asked: never logged, stored on a notice, cached or put in an
 * event; rendered as escaped text only.
 */
export interface SellerOrderCustomerName {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly customerShortName: string;
}

export type SellerOrderCustomerNamesFailure = AccessDenied | { readonly code: 'validation.failed' };

/** At most this many delivered seller orders per `myDeliveredSellerOrders` call, newest first. */
export const MAX_DELIVERED_SELLER_ORDERS = 200;

/**
 * One delivered seller order of the signed-in customer, for `reviews` (buyer reviews and ratings
 * package 1; verified buyers only). Ids and the delivery instant: no amount, address or name.
 * `offerIds` are the distinct offers on its lines.
 */
export interface DeliveredSellerOrder {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly deliveredAt: Temporal.Instant;
  readonly offerIds: readonly Id<'Offer'>[];
}

export type DeliveredSellerOrdersFailure = AccessDenied | { readonly code: 'validation.failed' };

/** The PaymentIntent an order holds (null before checkout created one). */
export interface OrderPaymentRef {
  readonly orderId: string;
  readonly paymentIntentId: string | null;
}

export type OrderPaymentRefFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  | { readonly code: 'ordering.order-not-found' };

/**
 * What is still open for the calling customer: orders waiting for payment or not yet delivered in
 * every seller order, and refunds still pending. Counts only.
 */
export interface OwnOpenObligations {
  readonly openOrders: number;
  readonly pendingRefunds: number;
}

export type OwnOpenObligationsFailure = AccessDenied;

/**
 * What `payments` (the Stripe webhook receiver) calls. Both methods take the system actor's
 * `CallContext` unchanged and are idempotent: a repeated event changes nothing.
 */
export interface OrderingFacade {
  /**
   * The card holds the money. Commits the stock, then captures, then confirms the order; if the
   * stock is gone or the amount differs the authorisation is voided and the order cancelled.
   * Call it for `checkout.session.completed` with an unpaid, authorised PaymentIntent.
   */
  confirmPayment(
    context: CallContext,
    payment: AuthorisedPayment,
  ): Promise<Result<'confirmed' | 'already-confirmed' | 'voided', PaymentFailure>>;

  /**
   * The payment page expired (`checkout.session.expired`) or the payment is final-failed. A
   * pending order is cancelled and its stock hold released; a settled order is left alone.
   * Do not call it for a single failed card attempt: the customer may retry on the same page.
   */
  cancelPayment(
    context: CallContext,
    request: { readonly orderId: string; readonly cause: 'expired' | 'payment-failed' },
  ): Promise<Result<'cancelled' | 'ignored', PaymentFailure>>;

  /**
   * The paid order behind an `ordering.order-paid.v1` event, for the order emails. Rule
   * `system`. An unknown, foreign-Market or not-yet-paid order is `ordering.order-not-found`.
   */
  orderNotice(
    context: CallContext,
    orderId: string,
  ): Promise<Result<OrderNotice, OrderNoticeFailure>>;

  /**
   * The shipment behind an `ordering.order-shipped.v1` event, for the "Shipped" email. Rule
   * `system`.
   */
  shipmentNotice(
    context: CallContext,
    request: { readonly orderId: string; readonly sellerOrderId: string },
  ): Promise<Result<ShipmentNotice, ShipmentNoticeFailure>>;

  /**
   * The PaymentIntent the order itself holds, for the dispute consumer of `commission-payouts`.
   * Rule `system`. An unknown or foreign-Market order is `ordering.order-not-found`.
   */
  orderPaymentRef(
    context: CallContext,
    orderId: string,
  ): Promise<Result<OrderPaymentRef, OrderPaymentRefFailure>>;

  /**
   * The short customer name of each of the seller's own paid seller orders asked for, for the
   * seller's order notices (read at render time; a notice stores no name). Rule `permissions
   * [ordering.seller-order.view]`, seller scope; a name shows only while the member also holds
   * `identity.customer-short-name.view`. Another shop's, unknown, unpaid and nameless seller
   * orders are absent. At most 100 ids.
   */
  sellerOrderCustomerNames(
    context: CallContext,
    sellerOrderIds: readonly string[],
  ): Promise<Result<readonly SellerOrderCustomerName[], SellerOrderCustomerNamesFailure>>;

  /**
   * The calling customer's own open orders and pending refunds, as counts (rule `own-resources`,
   * customers only; the account is the session's), for account deletion's blocker check. Returns,
   * disputes and chargebacks have no module yet, so they are not counted here.
   */
  ownOpenObligations(
    context: CallContext,
  ): Promise<Result<OwnOpenObligations, OwnOpenObligationsFailure>>;

  /**
   * The same counts for one customer account, for the system actor only (rule `system`): the
   * account deletion job re-checks a due request before it erases the account.
   */
  openObligationsOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<OwnOpenObligations, OwnOpenObligationsFailure>>;

  /**
   * The same counts for one customer account, asked by an admin's deletion request for a buyer
   * (customers package 5c). Rule `own-resources`: a platform admin that is not acting as a seller,
   * any other caller `access.denied`; the calling use case holds the permission.
   */
  adminOpenObligationsOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<OwnOpenObligations, OwnOpenObligationsFailure>>;

  /**
   * The signed-in customer's own seller orders whose fulfilment is `delivered`, delivered at or
   * after `deliveredSince`, newest delivery first, at most {@link MAX_DELIVERED_SELLER_ORDERS}.
   * With `sellerOrderId` only that seller order (the customer's own, else an empty list). Rule
   * `own-resources`; the caller passes the customer's `CallContext` unchanged, so another
   * customer's orders can never be asked for. A refunded order is still listed (a refund does
   * not take the right to review); an order cancelled before shipping never is. In-process only.
   */
  myDeliveredSellerOrders(
    context: CallContext,
    request: { readonly deliveredSince: Temporal.Instant; readonly sellerOrderId?: string },
  ): Promise<Result<readonly DeliveredSellerOrder[], DeliveredSellerOrdersFailure>>;
}

/** Nest token of the {@link OrderingFacade}, provided and exported by `OrderingModule`. */
export const ORDERING_FACADE = Symbol('ORDERING_FACADE');
