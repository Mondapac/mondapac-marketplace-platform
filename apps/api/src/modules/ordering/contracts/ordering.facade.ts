import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** A payment the provider holds on a card, as the webhook receiver reports it. */
export interface AuthorisedPayment {
  readonly orderId: string;
  readonly paymentIntentId: string;
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
}

/** Nest token of the {@link OrderingFacade}, provided and exported by `OrderingModule`. */
export const ORDERING_FACADE = Symbol('ORDERING_FACADE');
