import { createHmac } from 'node:crypto';
import { err, ok, Temporal as TemporalValue } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  MarketContext,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
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
  AccountPage,
  AppliedSchedule,
  ConnectedAccountRecord,
  ConnectedAccountStore,
  NewPayoutChange,
  PayoutChangeRecord,
} from '../../src/modules/payments/application/ports/connected-account-store';
import type {
  ConnectFailure,
  ConnectGateway,
  NormalPayoutSchedule,
  PayoutSchedule,
} from '../../src/modules/payments/application/ports/connect-gateway';
import type {
  OnboardingUrls,
  PaymentsPolicy,
} from '../../src/modules/payments/application/ports/payments-policy';
import type {
  AccountSnapshot,
  AccountStatus,
} from '../../src/modules/payments/domain/connected-account';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { PAYMENTS_AUDIT_ACTIONS } from '../../src/modules/payments/domain/audit';
import type { ConfirmSecondFactorFailure, IdentityFacade } from '../../src/modules/identity';
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
  orderNotice(): ReturnType<OrderingFacade['orderNotice']> {
    return Promise.resolve(err({ code: 'ordering.order-not-found' }));
  }
  shipmentNotice(): ReturnType<OrderingFacade['shipmentNotice']> {
    return Promise.resolve(err({ code: 'ordering.order-not-found' }));
  }

  sellerOrderCustomerNames(): ReturnType<OrderingFacade['sellerOrderCustomerNames']> {
    return Promise.resolve(ok([]));
  }
}

/** A connected-account event body, as the Connect endpoint receives it. */
export function accountEvent(fields: {
  readonly id?: string;
  readonly type?:
    | 'account.updated'
    | 'capability.updated'
    | 'account.external_account.created'
    | 'account.external_account.updated'
    | 'account.external_account.deleted';
  readonly livemode?: boolean;
  readonly account?: string | null;
  readonly marketId?: string;
}): Record<string, unknown> {
  const account = fields.account === undefined ? 'acct_test_0001' : fields.account;
  const capability = fields.type === 'capability.updated';
  const external = fields.type?.startsWith('account.external_account.') === true;
  return {
    id: fields.id ?? 'evt_test_acct_0001',
    object: 'event',
    type: fields.type ?? 'account.updated',
    livemode: fields.livemode ?? false,
    ...(account === null ? {} : { account }),
    data: {
      object: capability
        ? { id: 'transfers', object: 'capability', account }
        : external
          ? { id: 'ba_test_0001', object: 'bank_account', account }
          : {
              id: account,
              object: 'account',
              metadata: {
                market_id: fields.marketId ?? 'AU',
                seller_id: 'from-payload-not-trusted',
              },
            },
    },
  };
}

export const TEST_CONNECT_WEBHOOK_SECRET = 'whsec_test0connect0for0specs';

export class MemoryAccountStore implements ConnectedAccountStore {
  readonly rows = new Map<string, ConnectedAccountRecord & { market: string }>();
  readonly changes: (NewPayoutChange & { market: string; sellerId: string })[] = [];
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
      coolingOffUntil: null,
      payoutsPausedUntil: null,
      payoutScheduleApplied: null,
      payoutScheduleRevision: 0,
      lastChangeId: null,
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
  recordsOf(market: MarketContext, sellerIds: readonly string[]) {
    const map = new Map<string, ConnectedAccountRecord>();
    for (const id of sellerIds) {
      const row = this.rows.get(this.key(market, id));
      if (row !== undefined) map.set(id, row);
    }
    return Promise.resolve(map as ReadonlyMap<string, ConnectedAccountRecord>);
  }
  recordChange(
    market: MarketContext,
    sellerId: string,
    change: NewPayoutChange,
    expectedLastChangeId: string | null,
    until: Temporal.Instant | null,
  ) {
    const row = this.rows.get(this.key(market, sellerId));
    if (
      this.changes.some(
        (c) => c.market === market.marketId && c.sourceEventId === change.sourceEventId,
      )
    ) {
      return Promise.resolve('duplicate' as const);
    }
    if (row === undefined || row.lastChangeId !== expectedLastChangeId) {
      return Promise.resolve('conflict' as const);
    }
    this.rows.set(this.key(market, sellerId), {
      ...row,
      lastChangeId: change.id,
      coolingOffUntil: until,
      payoutsPausedUntil: until,
    });
    this.changes.push({ ...change, market: market.marketId, sellerId });
    return Promise.resolve('recorded' as const);
  }
  changesOf(market: MarketContext, sellerId: string, limit: number) {
    // Newest first; ids rise with time, so the later one wins a tie, as the database orders it.
    const mine: PayoutChangeRecord[] = this.changes
      .filter((c) => c.market === market.marketId && c.sellerId === sellerId)
      .map((c, index) => ({ c, index }))
      .sort(
        (a, b) =>
          b.c.detectedAt.epochMilliseconds - a.c.detectedAt.epochMilliseconds || b.index - a.index,
      )
      .map(({ c }) => c)
      .slice(0, limit);
    return Promise.resolve(mine);
  }
  markRepause(market: MarketContext, sellerId: string) {
    const row = this.rows.get(this.key(market, sellerId));
    if (row === undefined) return Promise.resolve(false);
    this.rows.set(this.key(market, sellerId), {
      ...row,
      payoutScheduleApplied: 'normal',
      payoutScheduleRevision: row.payoutScheduleRevision + 1,
    });
    return Promise.resolve(true);
  }
  dueForScheduleSync(market: MarketContext, now: Temporal.Instant, limit: number) {
    const at = now.epochMilliseconds;
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => {
          if (row.market !== market.marketId || row.accountRef === null) return false;
          const paused =
            row.payoutsPausedUntil !== null && row.payoutsPausedUntil.epochMilliseconds > at;
          const applied = row.payoutScheduleApplied ?? 'normal';
          return paused ? applied !== 'manual' : applied === 'manual';
        })
        .slice(0, limit),
    );
  }
  markScheduleApplied(
    market: MarketContext,
    sellerId: string,
    applied: AppliedSchedule,
    _at: Temporal.Instant,
    expected: { lastChangeId: string; revision: number },
  ) {
    const row = this.rows.get(this.key(market, sellerId));
    if (
      row === undefined ||
      row.lastChangeId !== expected.lastChangeId ||
      row.payoutScheduleRevision !== expected.revision
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(this.key(market, sellerId), { ...row, payoutScheduleApplied: applied });
    return Promise.resolve(true);
  }
  bumpScheduleRevision(market: MarketContext, sellerId: string, expectedRevision: number) {
    const row = this.rows.get(this.key(market, sellerId));
    if (row === undefined || row.payoutScheduleRevision !== expectedRevision) {
      return Promise.resolve(false);
    }
    this.rows.set(this.key(market, sellerId), {
      ...row,
      payoutScheduleRevision: expectedRevision + 1,
    });
    return Promise.resolve(true);
  }
  list(market: MarketContext, status: AccountStatus | null, page: AccountPage) {
    const rows = [...this.rows.values()]
      .filter((row) => row.market === market.marketId && (status === null || row.status === status))
      .sort(
        (a, b) =>
          b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds ||
          (a.sellerId < b.sellerId ? 1 : -1),
      )
      .filter(
        (row) =>
          page.after === null ||
          row.createdAt.epochMilliseconds < page.after.createdAt.epochMilliseconds ||
          (row.createdAt.epochMilliseconds === page.after.createdAt.epochMilliseconds &&
            row.sellerId < page.after.sellerId),
      );
    return Promise.resolve(rows.slice(0, page.limit + 1));
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
  readonly schedules: { accountRef: string; schedule: PayoutSchedule; idempotencyKey: string }[] =
    [];
  scheduleAnswer: Result<void, ConnectFailure> = ok(undefined);
  setPayoutSchedule(accountRef: string, schedule: PayoutSchedule, idempotencyKey: string) {
    this.schedules.push({ accountRef, schedule, idempotencyKey });
    return Promise.resolve(this.scheduleAnswer);
  }
}

export class StaticPaymentsPolicy implements PaymentsPolicy {
  constructor(
    private readonly country: string | null = 'AU',
    private readonly urls: OnboardingUrls | null = {
      returnUrl: 'https://seller.test/payout-account?stripe=return',
      refreshUrl: 'https://seller.test/payout-account?stripe=refresh',
    },
    private readonly coolingOffHours = 24,
    private readonly schedule: NormalPayoutSchedule | null = 'daily',
  ) {}
  bankChangeCoolingOffHours() {
    return this.coolingOffHours;
  }
  normalPayoutSchedule() {
    return this.schedule;
  }
  connectedAccountCountry() {
    return this.country;
  }
  onboardingUrls() {
    return this.urls;
  }
}

/** Collects audit rows, checked against the payments catalogue as the writer does. */
export class RecordingPaymentsAudit implements AuditWriter {
  readonly rows: (AuditEntry & { readonly actorKind: string })[] = [];
  record(context: CallContext, entry: AuditEntry): Promise<void> {
    const definition = PAYMENTS_AUDIT_ACTIONS.find((d) => d.action === entry.action);
    if (definition === undefined) throw new Error(`audit: unknown action ${entry.action}`);
    if (!definition.actors.includes(context.actor.kind))
      throw new Error('audit: actor not allowed');
    if (definition.targetType !== entry.targetType) throw new Error('audit: target type');
    this.rows.push({ ...entry, actorKind: context.actor.kind });
    return Promise.resolve();
  }
}

/**
 * The identity facade as payments uses it: whether the signed-in seller has two-step sign-in on,
 * and a code check that accepts one code (the `valid` field) and answers the configured refusal
 * otherwise. `checks` records the codes presented, in order.
 */
export class FakeIdentityFacade implements Pick<
  IdentityFacade,
  'describeActor' | 'confirmSecondFactor'
> {
  secondFactorActive = true;
  valid = '123456';
  failure: ConfirmSecondFactorFailure | null = null;
  readonly checks: string[] = [];
  describeActor(context: CallContext) {
    const actor = context.actor;
    if (actor.kind !== 'authenticated')
      return Promise.resolve(err({ code: 'access.denied' as const }));
    return Promise.resolve(
      ok({
        accountId: actor.accountId,
        population: actor.population,
        sellerId: actor.sellerId,
        roleId: null,
        permissionKeys: [],
        sellerAccessState: 'approved',
        secondFactorActive: this.secondFactorActive,
      }),
    );
  }
  confirmSecondFactor(_context: CallContext, code: string) {
    this.checks.push(code);
    if (this.failure !== null) return Promise.resolve(err(this.failure));
    return Promise.resolve(
      code === this.valid ? ok(undefined) : err({ code: 'second-factor.invalid' as const }),
    );
  }
}
