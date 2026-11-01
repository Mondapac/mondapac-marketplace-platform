import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaStripeEventInbox } from '../../src/modules/payments/infrastructure/prisma-stripe-event-inbox';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The Stripe event inbox on PostgreSQL (payments.stripe_events), as the application role, for
// both Market fixtures: one row per event id, the due order, finish once, retry later, the Market
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

  beforeAll(async () => {
    db = createPersistence();
    inbox = new PrismaStripeEventInbox(db.service);
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

    await value(market, () => inbox.retryLater(market, eventId, 1, far.add({ seconds: 10 })));
    expect(
      (await value(market, () => inbox.due(market, far, 500))).some((e) => e.eventId === eventId),
    ).toBe(false);
    const later = await value(market, () => inbox.due(market, far.add({ seconds: 10 }), 500));
    expect(later.find((e) => e.eventId === eventId)?.attempts).toBe(1);

    expect(await value(other, () => inbox.finish(other, eventId, 'confirmed', far))).toBe(false);
    expect(await value(market, () => inbox.finish(market, eventId, 'confirmed', far))).toBe(true);
    expect(await value(market, () => inbox.finish(market, eventId, 'voided', far))).toBe(false);
    const row = await sql.query<{ outcome: string; attempts: number }>(
      'SELECT outcome, attempts FROM payments.stripe_events WHERE market_id = $1 AND event_id = $2',
      [code, eventId],
    );
    expect(row.rows).toEqual([{ outcome: 'confirmed', attempts: 1 }]);
  });

  it.each([
    ['an unknown type', { type: 'charge.refunded' }],
    ['a malformed event id', { event_id: 'not-an-event' }],
    ['a malformed session id', { object_id: 'chk_123' }],
    ['an unknown PaymentIntent event', { type: 'payment_intent.succeeded', object_id: 'pi_123' }],
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
