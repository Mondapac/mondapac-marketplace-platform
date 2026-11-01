import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isAcceptedCard,
  isConfirmationToken,
  parseExpectedTotal,
  PAYMENT_ATTEMPTS_PER_WINDOW,
} from '../domain/card-payment';
import {
  placeOrder,
  type OrderingDependencies,
  type PaymentStep,
  type StartCheckoutFailure,
  type StartCheckoutInput,
} from './checkout-flow';
import type { CardPaymentAnswer } from './ports/checkout-gateway';

/**
 * What the customer sends to pay by card on the MondaPac page: the same address, notes and
 * delivery choices as the hosted checkout, the ConfirmationToken the browser got from Stripe's
 * Payment Element (the only thing of the card that reaches the server) and, optionally, the total
 * the buyer saw. No price, fee, discount or tax is ever taken from the client.
 */
export interface PayByCardInput extends StartCheckoutInput {
  readonly confirmationToken: unknown;
  readonly expectedTotal?: unknown;
}

export interface CardPaymentStarted {
  readonly orderId: Id<'Order'>;
  /**
   * `authorised`: the card holds the money; the order is confirmed a moment later, when Stripe's
   * signed event arrives (poll the order). `requires-action`: finish the bank's check in the
   * browser with `clientSecret`, then poll the order.
   */
  readonly status: CardPaymentAnswer['status'];
  /** Set only for `requires-action`; a secret of the browser session: never stored or logged. */
  readonly clientSecret: string | null;
  readonly payBy: Temporal.Instant;
  readonly total: Money;
}

/**
 * `pay-by-card`: the checkout of {@link placeOrder} with a card payment step. The server prices
 * the whole order; a total the buyer saw that differs is refused before anything is reserved; the
 * card brand is read from Stripe, not from the client; one manual-capture PaymentIntent is
 * created with the order's own key. Nothing is captured here: ordering captures after the stock
 * is committed, when the signed event arrives.
 */
export async function payByCard(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: PayByCardInput,
): Promise<Result<CardPaymentStarted, StartCheckoutFailure>> {
  const token = input?.confirmationToken;
  if (!isConfirmationToken(token)) {
    return err({
      code: 'validation.failed',
      fields: [{ path: 'confirmationToken', code: token === undefined ? 'required' : 'format' }],
    });
  }
  const expected = parseExpectedTotal(input?.expectedTotal);
  if (!expected.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'expectedTotal', code: 'format' }] });
  }
  // Each attempt reserves stock and calls Stripe: a customer has a few per window. A counter that
  // cannot be read refuses the attempt (fail closed).
  try {
    const counted = await deps.attempts.count(`${context.market.marketId}:${accountId}`);
    if (counted.count > PAYMENT_ATTEMPTS_PER_WINDOW) {
      return err({ code: 'request.throttled', retryAfterSeconds: counted.retryAfterSeconds });
    }
  } catch {
    return err({ code: 'access.unavailable' });
  }

  const step: PaymentStep<CardPaymentAnswer> = {
    async precheck(total) {
      if (
        expected.total !== null &&
        (expected.total.amount !== total.amount || expected.total.currency !== total.currency)
      ) {
        return { code: 'ordering.price-changed', total };
      }
      const facts = await deps.gateway.readConfirmationToken(token);
      if (!facts.ok) {
        return facts.error.code === 'payment.provider-rejected'
          ? { code: 'validation.failed', fields: [{ path: 'confirmationToken', code: 'invalid' }] }
          : { code: 'ordering.payment-unavailable' };
      }
      if (facts.value.livemode || !isAcceptedCard(facts.value.methodType, facts.value.cardBrand)) {
        return { code: 'ordering.card-not-accepted' };
      }
      return null;
    },
    async charge({ order, urls }) {
      const paid = await deps.gateway.payByCard({
        orderId: order.id,
        marketId: order.marketId,
        currency: order.total.currency,
        amount: order.total.amount,
        confirmationToken: token,
        returnUrl: urls.success,
        idempotencyKey: order.stripeIdempotencyKey,
      });
      if (!paid.ok) {
        if (paid.error.code === 'payment.card-declined') {
          // The bank said no: stop the PaymentIntent Stripe made (best effort), nothing is charged.
          if (paid.error.paymentIntentId !== null) {
            await deps.gateway.voidAuthorisation(
              paid.error.paymentIntentId,
              `void-${paid.error.paymentIntentId}`,
            );
          }
          return err({ code: 'ordering.card-declined' } as const);
        }
        return err({ code: 'ordering.payment-unavailable' } as const);
      }
      const intentId = paid.value.paymentIntentId;
      return ok({
        link: (fresh) => ({ ...fresh, stripePaymentIntentId: intentId }),
        answer: paid.value,
      });
    },
    async undo(charged) {
      await deps.gateway.voidAuthorisation(
        charged.answer.paymentIntentId,
        `void-${charged.answer.paymentIntentId}`,
      );
    },
  };

  const placed = await placeOrder(deps, context, accountId, input, step);
  if (!placed.ok) return placed;
  const { order, payBy, answer } = placed.value;
  return ok({
    orderId: order.id,
    status: answer.status,
    clientSecret: answer.status === 'requires-action' ? answer.clientSecret : null,
    payBy,
    total: order.total,
  });
}
