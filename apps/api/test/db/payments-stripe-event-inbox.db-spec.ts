import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, SequenceIdGenerator, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { applyStripeEvents, MAX_ATTEMPTS } from '../../src/modules/payments/application/apply-flow';
import type { PaymentsDependencies } from '../../src/modules/payments/application/payments-dependencies';
import type { StripeEventInbox } from '../../src/modules/payments/application/ports/stripe-event-inbox';
import { PrismaStripeEventInbox } from '../../src/modules/payments/infrastructure/prisma-stripe-event-inbox';
import { PrismaPaymentsWorkQueueCountReader } from '../../src/modules/payments/infrastructure/prisma-work-queue-count.reader';
import { StripeWebhookSignature } from '../../src/modules/payments/infrastructure/stripe-webhook-signature';
import {
  FakeConnectGateway,
  FakeDisputeReader,
  FakeIdentityFacade,
  FakeOrderingFacade,
  FakeSessionReader,
  FakeTransferGateway,
  MemoryAccountStore,
  MemoryDisputeStore,
  MemoryTransferStore,
  RecordingPaymentsAudit,
  RecordingPaymentsOutbox,
  StaticPaymentsPolicy,
  testKeyring,
  TEST_WEBHOOK_SECRET,
} from '../support/payments-fakes';
import { RecordingSecurityEvents } from '../support/recording-security-events';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The Stripe event inbox on PostgreSQL (payments.stripe_events), as the application role, for
// both Market fixtures: one row per event id, the due order, claim an attempt (also under a real
// concurrent update), finish once by the attempt's holder, the Market
// guard, and the CHECKs the application would never violate but the database must still refuse.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const CHECK = '23514';
let sequence = 0;
const nextEventId = () => `evt_test_${process.pid}_${(sequence += 1)}_${Date.now()}`;

describe.each(TEST_MARKETS)('Stripe event inbox in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let inbox: PrismaStripeEventInbox;
  let sql: Client;

  let counts: PrismaPaymentsWorkQueueCountReader;

  beforeAll(async () => {
    db = createPersistence();
    inbox = new PrismaStripeEventInbox(db.service);
    counts = new PrismaPaymentsWorkQueueCountReader(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  /** Waits until a session is blocked by `holder` (no fixed delay, no other spec's session). */
  const untilBlockedBy = async (holder: Client, timeoutMs = 10_000): Promise<void> => {
    const { rows: own } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await sql.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [own[0]!.pid],
      );
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no session waited behind the holder within ${timeoutMs} ms`);
  };
  const received = (eventId: string, at = T0) => ({
    eventId,
    type: 'checkout.session.completed' as const,
    objectId: 'cs_test_0001',
    receivedAt: at,
  });

  it('stores an event once, takes it when due, retries it later and finishes it once', async () => {
    const eventId = nextEventId();
    const far = T0.add({ hours: 1000 });

    expect(await value(market, () => inbox.record(market, received(eventId, far)))).toBe(
      'recorded',
    );
    expect(await value(market, () => inbox.record(market, received(eventId, far)))).toBe(
      'duplicate',
    );
    const due = await value(market, () => inbox.due(market, far, 500));
    expect(due.filter((e) => e.eventId === eventId)).toEqual([
      { ...received(eventId, far), attempts: 0 },
    ]);
    // Another Market never sees it.
    expect(
      (await value(other, () => inbox.due(other, far, 500))).some((e) => e.eventId === eventId),
    ).toBe(false);

    // Taken once: one attempt, due again only at its next attempt.
    expect(
      await value(market, () => inbox.claim(market, eventId, 0, far.add({ seconds: 60 }))),
    ).toBe(true);
    expect(
      (await value(market, () => inbox.due(market, far, 500))).some((e) => e.eventId === eventId),
    ).toBe(false);
    const later = await value(market, () => inbox.due(market, far.add({ seconds: 60 }), 500));
    expect(later.find((e) => e.eventId === eventId)?.attempts).toBe(1);
    // A stale count, another Market, or an attempt already taken: nothing changes.
    expect(await value(market, () => inbox.claim(market, eventId, 0, far))).toBe(false);
    expect(await value(other, () => inbox.claim(other, eventId, 1, far))).toBe(false);
    const stored = await sql.query<{ attempts: number; next_attempt_at: Date }>(
      'SELECT attempts, next_attempt_at FROM payments.stripe_events WHERE market_id = $1 AND event_id = $2',
      [code, eventId],
    );
    expect(stored.rows).toEqual([
      { attempts: 1, next_attempt_at: new Date(far.add({ seconds: 60 }).epochMilliseconds) },
    ]);

    // The outcome is written only by the run that holds the current attempt.
    expect(await value(market, () => inbox.finish(market, eventId, 'confirmed', far, 0))).toBe(
      false,
    );
    expect(await value(other, () => inbox.finish(other, eventId, 'confirmed', far, 1))).toBe(false);
    expect(await value(market, () => inbox.finish(market, eventId, 'confirmed', far, 1))).toBe(
      true,
    );
    expect(await value(market, () => inbox.finish(market, eventId, 'voided', far, 1))).toBe(false);
    expect(await value(market, () => inbox.claim(market, eventId, 1, far))).toBe(false);
    const row = await sql.query<{ outcome: string; attempts: number }>(
      'SELECT outcome, attempts FROM payments.stripe_events WHERE market_id = $1 AND event_id = $2',
      [code, eventId],
    );
    expect(row.rows).toEqual([{ outcome: 'confirmed', attempts: 1 }]);
  });

  it('lets one claim take an attempt when two race for the same row (real concurrency)', async () => {
    const eventId = nextEventId();
    const far = T0.add({ hours: 2000 });
    await value(market, () => inbox.record(market, received(eventId, far)));

    // An overlapping run has the row locked and is taking the same attempt.
    const holder = new Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE payments.stripe_events SET attempts = attempts + 1, next_attempt_at = $3
          WHERE market_id = $1 AND event_id = $2 AND processed_at IS NULL AND attempts = 0`,
        [code, eventId, new Date(far.add({ seconds: 60 }).epochMilliseconds)],
      );
      // Settled either way, so a failed wait below never leaves an unhandled rejection.
      const claiming = value(market, () =>
        inbox.claim(market, eventId, 0, far.add({ seconds: 90 })),
      ).then(
        (taken) => ({ taken }),
        (error: unknown) => ({ error }),
      );
      await untilBlockedBy(holder);
      await holder.query('COMMIT');

      // Re-checked after the other commit: the attempt is no longer 0, so this run takes nothing.
      expect(await claiming).toEqual({ taken: false });
    } finally {
      await holder.end();
    }
    const row = await sql.query<{ attempts: number; next_attempt_at: Date }>(
      'SELECT attempts, next_attempt_at FROM payments.stripe_events WHERE market_id = $1 AND event_id = $2',
      [code, eventId],
    );
    expect(row.rows).toEqual([
      { attempts: 1, next_attempt_at: new Date(far.add({ seconds: 60 }).epochMilliseconds) },
    ]);
  });

  it('keeps a taken attempt when the run dies before the end: the next run takes the next event', async () => {
    const at = T0.add({ hours: 3000 });
    const stuck = nextEventId();
    const next = nextEventId();
    await value(market, () => inbox.record(market, received(stuck, at)));
    await value(market, () => inbox.record(market, received(next, at.add({ seconds: 1 }))));

    // Taken in its own committed unit, then the process died: no outcome is ever written.
    expect(await value(market, () => inbox.claim(market, stuck, 0, at.add({ seconds: 60 })))).toBe(
      true,
    );

    const due = (await value(market, () => inbox.due(market, at.add({ seconds: 5 }), 500))).map(
      (e) => e.eventId,
    );
    expect(due).toContain(next);
    expect(due).not.toContain(stuck);
  });

  it('marks an event taken the last time and never finished failed without applying it, for the dashboard count', async () => {
    // Received in 2010: later than every row the dashboard spec counts as stuck (before 2000), and
    // no row of another spec file falls in the week before it (they use 1999-2000 and 2026).
    const receivedAt = Temporal.Instant.from('2010-03-01T00:00:00Z');
    const now = receivedAt.add({ hours: 1 });
    const eventId = nextEventId();
    await value(market, () => inbox.record(market, received(eventId, receivedAt)));
    await sql.query(
      'UPDATE payments.stripe_events SET attempts = $3 WHERE market_id = $1 AND event_id = $2',
      [code, eventId, MAX_ATTEMPTS],
    );
    const clock = new FixedClock(now);
    const reader = new FakeSessionReader();
    const ordering = new FakeOrderingFacade();
    // Only this event: other spec files keep unapplied rows in the same table.
    const onlyThis: StripeEventInbox = {
      record: (m, e) => inbox.record(m, e),
      due: async (m, n, limit) =>
        (await inbox.due(m, n, 10_000)).filter((e) => e.eventId === eventId).slice(0, limit),
      claim: (m, id, expected, at) => inbox.claim(m, id, expected, at),
      finish: (m, id, outcome, at, attempts) => inbox.finish(m, id, outcome, at, attempts),
    };
    const deps: PaymentsDependencies = {
      unitOfWork: db.unitOfWork,
      inbox: onlyThis,
      signature: new StripeWebhookSignature({ [code]: TEST_WEBHOOK_SECRET }, clock),
      reader,
      disputeReader: new FakeDisputeReader(),
      disputes: new MemoryDisputeStore(),
      outbox: new RecordingPaymentsOutbox(),
      ordering,
      accounts: new MemoryAccountStore(),
      connect: new FakeConnectGateway(),
      transfers: new MemoryTransferStore(),
      transferGateway: new FakeTransferGateway(),
      keyring: testKeyring(),
      policy: new StaticPaymentsPolicy(),
      identity: new FakeIdentityFacade(),
      audit: new RecordingPaymentsAudit(),
      securityEvents: new RecordingSecurityEvents(),
      ids: new SequenceIdGenerator(clock),
      clock,
    };

    const summary = await applyStripeEvents(
      deps,
      testCallContext(market, 'system', 'pay-0003-abcd'),
    );

    expect(summary).toEqual(
      ok({ applied: 1, retried: 0, threw: 0, problems: [{ eventId, outcome: 'failed' }] }),
    );
    expect(reader.reads).toEqual([]);
    expect(ordering.confirms).toEqual([]);
    const row = await sql.query<{ outcome: string; attempts: number }>(
      'SELECT outcome, attempts FROM payments.stripe_events WHERE market_id = $1 AND event_id = $2',
      [code, eventId],
    );
    expect(row.rows).toEqual([{ outcome: 'failed', attempts: MAX_ATTEMPTS }]);
    const counted = await db.unitOfWork.run(
      market,
      async () =>
        ok(await counts.failedWebhooks(market, now, Temporal.Instant.from('1990-01-01T00:00:00Z'))),
      { readOnly: true },
    );
    expect(counted.ok && counted.value.oldestAt).toEqual(receivedAt);
    expect(counted.ok && counted.value.count).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['an unknown type', { type: 'charge.refunded' }],
    ['a malformed event id', { event_id: 'not-an-event' }],
    ['a malformed session id', { object_id: 'chk_123' }],
    ['an unknown PaymentIntent event', { type: 'payment_intent.succeeded', object_id: 'pi_123' }],
    ['a PaymentIntent id on a Checkout Session event', { object_id: 'pi_123' }],
    [
      'a session id on a PaymentIntent event',
      { type: 'payment_intent.canceled', object_id: 'cs_1' },
    ],
  ])('refuses %s', async (_label, change) => {
    const row: Record<string, unknown> = {
      event_id: nextEventId(),
      market_id: code,
      tenant_id: market.tenantId,
      type: 'checkout.session.expired',
      object_id: 'cs_test_1',
      received_at: '2026-10-14T10:00:00Z',
      attempts: 0,
      next_attempt_at: '2026-10-14T10:00:00Z',
      ...change,
    };
    const columns = Object.keys(row);
    await expect(
      sql.query(
        `INSERT INTO payments.stripe_events (${columns.join(', ')}) VALUES (${columns
          .map((_c, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(row),
      ),
    ).rejects.toMatchObject({ code: CHECK });
  });

  it.each([
    'payment_intent.amount_capturable_updated',
    'payment_intent.payment_failed',
    'payment_intent.canceled',
  ] as const)('keeps a %s event of a PaymentIntent (card payment on our page)', async (type) => {
    const eventId = nextEventId();
    const event = { ...received(eventId), type, objectId: 'pi_test_0001' };

    expect(await value(market, () => inbox.record(market, event))).toBe('recorded');
    const row = await sql.query<{ type: string; object_id: string }>(
      'SELECT type, object_id FROM payments.stripe_events WHERE market_id = $1 AND event_id = $2',
      [code, eventId],
    );
    expect(row.rows).toEqual([{ type, object_id: 'pi_test_0001' }]);
  });

  it('refuses an outcome without a processed time, and an unknown outcome', async () => {
    const eventId = nextEventId();
    await value(market, () => inbox.record(market, received(eventId)));

    await expect(
      sql.query(
        `UPDATE payments.stripe_events SET outcome = 'confirmed' WHERE market_id = $1 AND event_id = $2`,
        [code, eventId],
      ),
    ).rejects.toMatchObject({ code: CHECK });
    await expect(
      sql.query(
        `UPDATE payments.stripe_events SET outcome = 'paid', processed_at = now() WHERE market_id = $1 AND event_id = $2`,
        [code, eventId],
      ),
    ).rejects.toMatchObject({ code: CHECK });
  });
});
