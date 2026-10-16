import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
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
}

/** Nest token of the {@link OrderingFacade}, provided and exported by `OrderingModule`. */
export const ORDERING_FACADE = Symbol('ORDERING_FACADE');
