import { createHmac } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type {
  EventOutcome,
  PendingEvent,
  ReceivedEvent,
  StripeEventInbox,
} from '../../src/modules/payments/application/ports/stripe-event-inbox';
import type {
  CheckoutSessionSnapshot,
  ReadFailure,
  StripeSessionReader,
} from '../../src/modules/payments/application/ports/stripe-session-reader';
import type { AuthorisedPayment, OrderingFacade, PaymentFailure } from '../../src/modules/ordering';

// In-memory ports of payments for the use-case spec and the HTTP spec, and a signer that builds
// the `Stripe-Signature` header exactly as Stripe's test mode does.

export const TEST_WEBHOOK_SECRET = 'whsec_test0secret0for0specs';

/** `t=<seconds>,v1=<HMAC-SHA256 of "<t>.<body>">`, as Stripe signs a webhook. */
export function stripeSignatureHeader(
  body: string | Buffer,
  at: Temporal.Instant,
  secret = TEST_WEBHOOK_SECRET,
): string {
  const t = Math.floor(at.epochMilliseconds / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** A Stripe event body of a Checkout session, as the webhook receives it. */
export function checkoutEvent(fields: {
  readonly id?: string;
  readonly type?: string;
  readonly livemode?: boolean;
  readonly account?: string;
  readonly sessionId?: string;
  readonly marketId?: string;
}): Record<string, unknown> {
  return {
    id: fields.id ?? 'evt_test_0001',
    object: 'event',
    type: fields.type ?? 'checkout.session.completed',
    livemode: fields.livemode ?? false,
    ...(fields.account === undefined ? {} : { account: fields.account }),
    data: {
      object: {
        id: fields.sessionId ?? 'cs_test_0001',
        object: 'checkout.session',
        metadata: { market_id: fields.marketId ?? 'AU', order_id: 'from-payload-not-trusted' },
      },
    },
  };
}

interface Row extends PendingEvent {
  readonly market: string;
  nextAttemptAt: Temporal.Instant;
  processedAt: Temporal.Instant | null;
  outcome: EventOutcome | null;
}

export class MemoryInbox implements StripeEventInbox {
  readonly rows = new Map<string, Row>();
  record(market: MarketContext, event: ReceivedEvent) {
    const key = `${market.marketId}/${event.eventId}`;
    if (this.rows.has(key)) return Promise.resolve('duplicate' as const);
    this.rows.set(key, {
      ...event,
      market: market.marketId,
      attempts: 0,
      nextAttemptAt: event.receivedAt,
      processedAt: null,
      outcome: null,
    });
    return Promise.resolve('recorded' as const);
  }
  due(market: MarketContext, now: Temporal.Instant, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) =>
            r.market === market.marketId &&
            r.processedAt === null &&
            r.nextAttemptAt.epochMilliseconds <= now.epochMilliseconds,
        )
        .slice(0, limit)
        .map(({ eventId, type, objectId, receivedAt, attempts }) => ({
          eventId,
          type,
          objectId,
          receivedAt,
          attempts,
        })),
    );
  }
  finish(market: MarketContext, eventId: string, outcome: EventOutcome, at: Temporal.Instant) {
    const row = this.rows.get(`${market.marketId}/${eventId}`);
    if (row === undefined || row.processedAt !== null) return Promise.resolve(false);
    row.processedAt = at;
    row.outcome = outcome;
    return Promise.resolve(true);
  }
  retryLater(market: MarketContext, eventId: string, attempts: number, next: Temporal.Instant) {
    const row = this.rows.get(`${market.marketId}/${eventId}`);
    if (row !== undefined && row.processedAt === null) {
      this.rows.set(`${market.marketId}/${eventId}`, { ...row, attempts, nextAttemptAt: next });
    }
    return Promise.resolve();
  }
  get(market: string, eventId: string): Row | undefined {
    return this.rows.get(`${market}/${eventId}`);
  }
}

export class FakeSessionReader implements StripeSessionReader {
  readonly reads: string[] = [];
  answer: Result<CheckoutSessionSnapshot, ReadFailure> = err({
    code: 'payment.provider-unavailable',
  });
  readCheckoutSession(sessionId: string) {
    this.reads.push(sessionId);
    return Promise.resolve(this.answer);
  }
}

export class FakeOrderingFacade implements OrderingFacade {
  readonly confirms: { context: CallContext; payment: AuthorisedPayment }[] = [];
  readonly cancels: { orderId: string; cause: string }[] = [];
  confirmAnswer: Result<'confirmed' | 'already-confirmed' | 'voided', PaymentFailure> =
    ok('confirmed');
  cancelAnswer: Result<'cancelled' | 'ignored', PaymentFailure> = ok('cancelled');
  confirmPayment(context: CallContext, payment: AuthorisedPayment) {
    this.confirms.push({ context, payment });
    return Promise.resolve(this.confirmAnswer);
  }
  cancelPayment(
    _context: CallContext,
    request: { readonly orderId: string; readonly cause: 'expired' | 'payment-failed' },
  ) {
    this.cancels.push({ ...request });
    return Promise.resolve(this.cancelAnswer);
  }
}
