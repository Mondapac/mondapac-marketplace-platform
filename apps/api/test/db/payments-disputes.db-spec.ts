import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { DisputeRecord } from '../../src/modules/payments/application/ports/dispute-store';
import { mergeDisputeState } from '../../src/modules/payments/domain/dispute';
import { PrismaDisputeStore } from '../../src/modules/payments/infrastructure/prisma-dispute-store';
import { PrismaStripeEventInbox } from '../../src/modules/payments/infrastructure/prisma-stripe-event-inbox';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The dispute store on PostgreSQL (payments.disputes, package 8a), as the application role, for
// both Market fixtures: one row per Stripe dispute, the version and read-order guard, the Market
// guard, the dispute events in the inbox, and the CHECKs and trigger that refuse what the
// application would never write: a money move taken back, a closed outcome changed, a skipped
// version.

const T0 = Temporal.Instant.from('2026-10-27T10:00:00Z');
const CHECK = '23514';
const RESTRICT = '23001';
let sequence = 0;
const nextDisputeRef = () => `dp_test_${process.pid}_${(sequence += 1)}_${Date.now()}`;

describe.each(TEST_MARKETS)('dispute store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let store: PrismaDisputeStore;
  let inbox: PrismaStripeEventInbox;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    store = new PrismaDisputeStore(db.service);
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
  const record = (fields: Partial<DisputeRecord> = {}): DisputeRecord => ({
    id: randomUUID(),
    providerDisputeId: nextDisputeRef(),
    orderId: randomUUID(),
    paymentIntentRef: 'pi_test_0001',
    amountMinor: 3000n,
    currency: code === 'AU' ? 'AUD' : 'JPY',
    ...mergeDisputeState(
      null,
      {
        status: 'needs_response',
        reason: 'fraudulent',
        evidenceDueBy: T0.add({ hours: 240 }),
        fundsWithdrawn: false,
        fundsReinstated: false,
      },
      T0,
    ),
    openedAt: T0.subtract({ hours: 2 }),
    createdAt: T0,
    updatedAt: T0,
    lastReadAt: T0,
    version: 1,
    ...fields,
  });

  it('stores a dispute once, reads it back and lets no other Market see it', async () => {
    const dispute = record();

    expect(await value(market, () => store.insert(market, dispute))).toBe('inserted');
    expect(await value(market, () => store.insert(market, { ...dispute, id: randomUUID() }))).toBe(
      'conflict',
    );
    expect(await value(market, () => store.findByRef(market, dispute.providerDisputeId))).toEqual(
      dispute,
    );
    expect(await value(market, () => store.findMany(market, [dispute.id, randomUUID()]))).toEqual([
      dispute,
    ]);
    expect(await value(other, () => store.findByRef(other, dispute.providerDisputeId))).toBeNull();
    expect(await value(other, () => store.findMany(other, [dispute.id]))).toEqual([]);
  });

  it('updates only at the expected version and never with an older read', async () => {
    const dispute = record();
    await value(market, () => store.insert(market, dispute));
    const t1 = T0.add({ minutes: 1 });
    const withdrawn = mergeDisputeState(
      dispute,
      { ...dispute, status: 'under_review', fundsWithdrawn: true, fundsReinstated: false },
      t1,
    );

    expect(await value(market, () => store.update(market, dispute.id, 2, withdrawn, t1))).toBe(
      false,
    );
    expect(
      await value(market, () =>
        store.update(market, dispute.id, 1, withdrawn, T0.subtract({ minutes: 1 })),
      ),
    ).toBe(false);
    expect(await value(other, () => store.update(other, dispute.id, 1, withdrawn, t1))).toBe(false);
    expect(await value(market, () => store.update(market, dispute.id, 1, withdrawn, t1))).toBe(
      true,
    );
    expect(await value(market, () => store.findByRef(market, dispute.providerDisputeId))).toEqual({
      ...dispute,
      ...withdrawn,
      updatedAt: t1,
      lastReadAt: t1,
      version: 2,
    });
  });

  it('keeps the dispute events in the inbox with their outcomes', async () => {
    const eventId = `evt_test_${process.pid}_${(sequence += 1)}_${Date.now()}`;
    expect(
      await value(market, () =>
        inbox.record(market, {
          eventId,
          type: 'charge.dispute.funds_withdrawn',
          objectId: 'dp_test_0001',
          receivedAt: T0,
        }),
      ),
    ).toBe('recorded');
    expect(await value(market, () => inbox.finish(market, eventId, 'other-market', T0))).toBe(true);
  });

  describe('guards', () => {
    let row: DisputeRecord;
    beforeEach(async () => {
      row = record();
      await value(market, () => store.insert(market, row));
    });
    const update = (set: string, params: unknown[] = []) =>
      sql.query(
        `UPDATE payments.disputes SET ${set}, version = version + 1, last_read_at = last_read_at
         WHERE market_id = $1 AND id = $2`,
        [code, row.id, ...params],
      );

    it('refuses to take back a withdrawal or a reinstatement, or move its instant', async () => {
      await update(`funds_withdrawn = true, funds_withdrawn_at = now()`);
      await expect(
        update(`funds_withdrawn = false, funds_withdrawn_at = NULL`),
      ).rejects.toMatchObject({ code: RESTRICT });
      await expect(update(`funds_withdrawn_at = now() + interval '1 day'`)).rejects.toMatchObject({
        code: RESTRICT,
      });
      await update(`funds_reinstated = true, funds_reinstated_at = now()`);
      await expect(
        update(`funds_reinstated = false, funds_reinstated_at = NULL`),
      ).rejects.toMatchObject({ code: RESTRICT });
    });

    it('refuses to change a closed outcome or its status', async () => {
      await update(`status = 'lost', outcome = 'lost'`);
      await expect(update(`status = 'won', outcome = 'won'`)).rejects.toMatchObject({
        code: RESTRICT,
      });
      await expect(update(`reason = 'general'`)).resolves.toMatchObject({ rowCount: 1 });
    });

    it('refuses a skipped version and an older read', async () => {
      await expect(
        sql.query(
          `UPDATE payments.disputes SET version = version + 2 WHERE market_id = $1 AND id = $2`,
          [code, row.id],
        ),
      ).rejects.toMatchObject({ code: RESTRICT });
      await expect(
        sql.query(
          `UPDATE payments.disputes SET version = version + 1,
             last_read_at = last_read_at - interval '1 second' WHERE market_id = $1 AND id = $2`,
          [code, row.id],
        ),
      ).rejects.toMatchObject({ code: RESTRICT });
    });

    it.each([
      ['an outcome on an open dispute', `outcome = 'won'`],
      ['a won status without its outcome', `status = 'won'`],
      ['an unknown status', `status = 'escalated'`],
      ['an unknown reason', `reason = 'because'`],
      ['a withdrawal without its instant', `funds_withdrawn = true`],
      [
        'a reinstatement before a withdrawal',
        `funds_reinstated = true, funds_reinstated_at = now()`,
      ],
    ])('refuses %s', async (_label, set) => {
      await expect(update(set)).rejects.toMatchObject({ code: CHECK });
    });
  });

  it.each([
    ['a malformed dispute id', { provider_dispute_id: 'ch_123' }],
    ['a zero amount', { amount_minor: 0 }],
    ['a lower-case currency', { currency: 'aud' }],
    ['a malformed PaymentIntent', { payment_intent_ref: 'ch_123' }],
  ])('refuses to insert %s', async (_label, change) => {
    const values: Record<string, unknown> = {
      market_id: code,
      id: randomUUID(),
      tenant_id: market.tenantId,
      provider_dispute_id: nextDisputeRef(),
      order_id: randomUUID(),
      payment_intent_ref: 'pi_test_1',
      amount_minor: 3000,
      currency: 'AUD',
      status: 'needs_response',
      reason: 'fraudulent',
      funds_withdrawn: false,
      funds_reinstated: false,
      opened_at: '2026-10-27T08:00:00Z',
      created_at: '2026-10-27T10:00:00Z',
      updated_at: '2026-10-27T10:00:00Z',
      last_read_at: '2026-10-27T10:00:00Z',
      version: 1,
      ...change,
    };
    const columns = Object.keys(values);
    await expect(
      sql.query(
        `INSERT INTO payments.disputes (${columns.join(', ')}) VALUES (${columns
          .map((_c, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(values),
      ),
    ).rejects.toMatchObject({ code: CHECK });
  });
});
