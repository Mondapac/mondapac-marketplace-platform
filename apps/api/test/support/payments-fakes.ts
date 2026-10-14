import { createHmac } from 'node:crypto';
import { err, ok, Temporal as TemporalValue } from '@mondapac/shared-kernel';
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
import type {
  ConnectedAccountRecord,
  ConnectedAccountStore,
} from '../../src/modules/payments/application/ports/connected-account-store';
import type {
  ConnectFailure,
  ConnectGateway,
} from '../../src/modules/payments/application/ports/connect-gateway';
import type {
  OnboardingUrls,
  PaymentsPolicy,
} from '../../src/modules/payments/application/ports/payments-policy';
import type {
  AccountSnapshot,
  AccountStatus,
} from '../../src/modules/payments/domain/connected-account';
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

/** A connected-account event body, as the Connect endpoint receives it. */
export function accountEvent(fields: {
  readonly id?: string;
  readonly type?: 'account.updated' | 'capability.updated';
  readonly livemode?: boolean;
  readonly account?: string | null;
  readonly marketId?: string;
}): Record<string, unknown> {
  const account = fields.account === undefined ? 'acct_test_0001' : fields.account;
  const capability = fields.type === 'capability.updated';
  return {
    id: fields.id ?? 'evt_test_acct_0001',
    object: 'event',
    type: fields.type ?? 'account.updated',
    livemode: fields.livemode ?? false,
    ...(account === null ? {} : { account }),
    data: {
      object: capability
        ? { id: 'transfers', object: 'capability', account }
        : {
            id: account,
            object: 'account',
            metadata: { market_id: fields.marketId ?? 'AU', seller_id: 'from-payload-not-trusted' },
          },
    },
  };
}

export const TEST_CONNECT_WEBHOOK_SECRET = 'whsec_test0connect0for0specs';

export class MemoryAccountStore implements ConnectedAccountStore {
  readonly rows = new Map<string, ConnectedAccountRecord & { market: string }>();
  private key = (market: MarketContext, sellerId: string) => `${market.marketId}/${sellerId}`;
  find(market: MarketContext, sellerId: string) {
    return Promise.resolve(this.rows.get(this.key(market, sellerId)) ?? null);
  }
  findByRef(market: MarketContext, accountRef: string) {
    return Promise.resolve(
      [...this.rows.values()].find(
        (row) => row.market === market.marketId && row.accountRef === accountRef,
      ) ?? null,
    );
  }
  now: Temporal.Instant | null = null;
  insert(market: MarketContext, sellerId: string, at?: Temporal.Instant) {
    const key = this.key(market, sellerId);
    if (this.rows.has(key)) return Promise.resolve(false);
    this.rows.set(key, {
      market: market.marketId,
      sellerId,
      accountRef: null,
      status: 'not-started',
      detailsSubmitted: false,
      transfersActive: false,
      payoutsEnabled: false,
      requirementsDue: 0,
      requirementsPastDue: false,
      lastReadAt: null,
      createdAt: at ?? this.now ?? TemporalValue.Instant.from('2026-10-14T10:00:00Z'),
    });
    return Promise.resolve(true);
  }
  linkRef(market: MarketContext, sellerId: string, accountRef: string) {
    const row = this.rows.get(this.key(market, sellerId));
    if (row === undefined || row.accountRef !== null) return Promise.resolve(false);
    this.rows.set(this.key(market, sellerId), { ...row, accountRef });
    return Promise.resolve(true);
  }
  applyRead(
    market: MarketContext,
    sellerId: string,
    snapshot: AccountSnapshot,
    status: AccountStatus,
    readAt: Temporal.Instant,
  ) {
    const row = this.rows.get(this.key(market, sellerId));
    if (
      row === undefined ||
      row.accountRef !== snapshot.id ||
      (row.lastReadAt !== null && row.lastReadAt.epochMilliseconds >= readAt.epochMilliseconds)
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(this.key(market, sellerId), {
      ...row,
      status,
      detailsSubmitted: snapshot.detailsSubmitted,
      transfersActive: snapshot.transfersActive,
      payoutsEnabled: snapshot.payoutsEnabled,
      requirementsDue: snapshot.requirementsDue,
      requirementsPastDue: snapshot.requirementsPastDue,
      lastReadAt: readAt,
    });
    return Promise.resolve(true);
  }
  statusesOf(market: MarketContext, sellerIds: readonly string[]) {
    const map = new Map<string, AccountStatus>();
    for (const id of sellerIds) {
      const row = this.rows.get(this.key(market, id));
      if (row !== undefined) map.set(id, row.status);
    }
    return Promise.resolve(map as ReadonlyMap<string, AccountStatus>);
  }
}

export class FakeConnectGateway implements ConnectGateway {
  readonly creates: {
    idempotencyKey: string;
    country: string;
    marketId: string;
    sellerId: string;
  }[] = [];
  readonly links: { accountRef: string; kind: string; returnUrl: string; refreshUrl: string }[] =
    [];
  readonly reads: string[] = [];
  createAnswer: Result<{ accountRef: string }, ConnectFailure> = ok({
    accountRef: 'acct_test_0001',
  });
  linkAnswer: Result<{ url: string }, ConnectFailure> = ok({
    url: 'https://connect.stripe.test/setup/s/abc',
  });
  readAnswer: Result<AccountSnapshot, ConnectFailure> = err({
    code: 'payment.provider-unavailable',
  });
  createAccount(request: {
    idempotencyKey: string;
    country: string;
    marketId: string;
    sellerId: string;
  }) {
    this.creates.push({ ...request });
    return Promise.resolve(this.createAnswer);
  }
  createAccountLink(request: {
    accountRef: string;
    kind: 'onboarding' | 'update';
    returnUrl: string;
    refreshUrl: string;
  }) {
    this.links.push({ ...request });
    return Promise.resolve(this.linkAnswer);
  }
  readAccount(accountRef: string) {
    this.reads.push(accountRef);
    return Promise.resolve(this.readAnswer);
  }
}

export class StaticPaymentsPolicy implements PaymentsPolicy {
  constructor(
    private readonly country: string | null = 'AU',
    private readonly urls: OnboardingUrls | null = {
      returnUrl: 'https://seller.test/payout-account?stripe=return',
      refreshUrl: 'https://seller.test/payout-account?stripe=refresh',
    },
  ) {}
  connectedAccountCountry() {
    return this.country;
  }
  onboardingUrls() {
    return this.urls;
  }
}
