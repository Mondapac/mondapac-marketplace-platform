import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaConnectedAccountStore } from '../../src/modules/payments/infrastructure/prisma-connected-account-store';
import { PrismaStripeEventInbox } from '../../src/modules/payments/infrastructure/prisma-stripe-event-inbox';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  randomUUID,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The bank-change history and the payout pause columns on PostgreSQL, as the application role, for
// both Market fixtures: an insert-only history with one row per Stripe event, the moves of the
// waiting period guarded by the latest change, the due list of the schedule job, the list order,
// the CHECKs the application would never violate, and the privileges.

const T0 = Temporal.Instant.from('2026-10-15T10:00:00Z');
const CHECK = '23514';
const DENIED = '42501';
const FOREIGN_KEY = '23503';
const UNIQUE = '23505';
const RESTRICT = '23001';
let sequence = 0;
const nextEvent = () => `evt_test_${process.pid}_${(sequence += 1)}_${Date.now()}`;
const nextRef = () => `acct_test_${process.pid}_${(sequence += 1)}_${Date.now()}`;

describe.each(TEST_MARKETS)('payout account changes in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let store: PrismaConnectedAccountStore;
  let inbox: PrismaStripeEventInbox;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    store = new PrismaConnectedAccountStore(db.service);
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
  /** A seller with a linked account. */
  const seller = async (at = T0) => {
    const sellerId = randomUUID();
    await value(market, () => store.insert(market, sellerId, at));
    await value(market, () => store.linkRef(market, sellerId, nextRef(), at));
    return sellerId;
  };
  const change = (
    kind: 'initial' | 'added' | 'updated' | 'removed',
    at: Temporal.Instant,
    until: Temporal.Instant | null,
  ) => ({
    id: randomUUID(),
    kind,
    detectedAt: at,
    coolingOffUntil: until,
    sourceEventId: nextEvent(),
    detectedBy: 'webhook' as const,
  });

  it('records changes guarded by the latest change, once per Stripe event, newest first', async () => {
    const sellerId = await seller();
    const first = change('initial', T0, null);
    expect(
      await value(market, () => store.recordChange(market, sellerId, first, null, null, T0)),
    ).toBe('recorded');
    expect(await value(market, () => store.find(market, sellerId))).toMatchObject({
      lastChangeId: first.id,
      coolingOffUntil: null,
      payoutsPausedUntil: null,
    });

    const at = T0.add({ hours: 2 });
    const until = at.add({ hours: 24 });
    const second = change('updated', at, until);
    // The same Stripe event again adds nothing and moves nothing.
    expect(
      await value(market, () =>
        store.recordChange(
          market,
          sellerId,
          { ...second, sourceEventId: first.sourceEventId },
          first.id,
          until,
          at,
        ),
      ),
    ).toBe('duplicate');
    // A change computed from a stale latest change is refused and writes nothing.
    expect(
      await value(market, () => store.recordChange(market, sellerId, second, null, until, at)),
    ).toBe('conflict');
    expect(await value(market, () => store.changesOf(market, sellerId, 10))).toHaveLength(1);
    expect(
      await value(market, () => store.recordChange(market, sellerId, second, first.id, until, at)),
    ).toBe('recorded');

    expect(await value(market, () => store.find(market, sellerId))).toMatchObject({
      lastChangeId: second.id,
      coolingOffUntil: until,
      payoutsPausedUntil: until,
    });
    const history = await value(market, () => store.changesOf(market, sellerId, 10));
    expect(history.map((c) => [c.kind, c.coolingOffUntil])).toEqual([
      ['updated', until],
      ['initial', null],
    ]);
    expect(await value(market, () => store.changesOf(market, sellerId, 1))).toHaveLength(1);
    // Another Market sees none of it, and cannot write a change for the seller.
    expect(await value(other, () => store.changesOf(other, sellerId, 10))).toEqual([]);
    expect(
      await value(other, () =>
        store.recordChange(other, sellerId, change('added', at, until), null, until, at),
      ),
    ).toBe('conflict');
  });

  it('lists the accounts whose Stripe schedule differs from the wanted one, and moves the applied state', async () => {
    const sellerId = await seller();
    const now = T0.add({ hours: 1 });
    const dueIds = async (at: Temporal.Instant) =>
      (await value(market, () => store.dueForScheduleSync(market, at, 200))).map((r) => r.sellerId);
    expect(await dueIds(now)).not.toContain(sellerId);

    const until = now.add({ hours: 24 });
    await value(market, () =>
      store.recordChange(market, sellerId, change('updated', now, until), null, until, now),
    );
    // Paused and not yet manual at Stripe: due. Written: not due until the period ends.
    expect(await dueIds(now)).toContain(sellerId);
    const guard = (revision: number, lastChangeId: string) => ({ lastChangeId, revision });
    const latest = (await value(market, () => store.find(market, sellerId)))!.lastChangeId!;
    // The write is stored only while the latest change and the revision are those it was made for.
    expect(
      await value(market, () =>
        store.markScheduleApplied(market, sellerId, 'manual', now, guard(0, randomUUID())),
      ),
    ).toBe(false);
    expect(
      await value(market, () =>
        store.markScheduleApplied(market, sellerId, 'manual', now, guard(1, latest)),
      ),
    ).toBe(false);
    expect(await dueIds(now)).toContain(sellerId);
    expect(
      await value(market, () =>
        store.markScheduleApplied(market, sellerId, 'manual', now, guard(0, latest)),
      ),
    ).toBe(true);
    expect(await dueIds(now)).not.toContain(sellerId);
    // The period over and still manual: due again; resumed: not due.
    expect(await dueIds(until)).toContain(sellerId);
    await value(market, () =>
      store.markScheduleApplied(market, sellerId, 'normal', until, guard(0, latest)),
    );
    expect(await dueIds(until)).not.toContain(sellerId);

    // A read that finds the pause undone marks the account whatever its applied state was.
    expect(await value(market, () => store.markRepause(market, sellerId, now))).toBe(true);
    expect(await value(market, () => store.find(market, sellerId))).toMatchObject({
      payoutScheduleApplied: 'normal',
      payoutScheduleRevision: 1,
    });
    // An answered Stripe error moves the revision once, only from the revision it was made at.
    expect(await value(market, () => store.bumpScheduleRevision(market, sellerId, 0, now))).toBe(
      false,
    );
    expect(await value(market, () => store.bumpScheduleRevision(market, sellerId, 1, now))).toBe(
      true,
    );
    expect(await value(market, () => store.find(market, sellerId))).toMatchObject({
      payoutScheduleRevision: 2,
    });
    expect(await dueIds(now)).toContain(sellerId);
    expect(await value(other, () => store.dueForScheduleSync(other, now, 200))).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sellerId })]),
    );
  });

  it('pages the accounts newest created first, by status and cursor', async () => {
    const base = T0.add({ hours: 24 * (300 + Math.floor(Math.random() * 500)) });
    const ids = [] as string[];
    for (let index = 0; index < 3; index += 1) {
      const sellerId = randomUUID();
      ids.push(sellerId);
      await value(market, () => store.insert(market, sellerId, base.add({ minutes: index })));
    }
    const firstPage = await value(market, () =>
      store.list(market, 'not-started', { limit: 2, after: null }),
    );
    expect(firstPage).toHaveLength(3);
    expect(firstPage.slice(0, 3).map((r) => r.sellerId)).toEqual([...ids].reverse());
    const rest = await value(market, () =>
      store.list(market, 'not-started', {
        limit: 2,
        after: { createdAt: firstPage[1]!.createdAt, sellerId: firstPage[1]!.sellerId },
      }),
    );
    expect(rest[0]?.sellerId).toBe(ids[0]);
    expect(
      await value(market, () => store.list(market, 'enabled', { limit: 5, after: null })),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ sellerId: ids[0] })]));
    expect(
      (await value(other, () => store.list(other, 'not-started', { limit: 500, after: null }))).map(
        (r) => r.sellerId,
      ),
    ).not.toContain(ids[0]);
  });

  it('keeps the external-account events in the inbox', async () => {
    for (const type of [
      'account.external_account.created',
      'account.external_account.updated',
      'account.external_account.deleted',
    ] as const) {
      const eventId = nextEvent();
      expect(
        await value(market, () =>
          inbox.record(market, { eventId, type, objectId: nextRef(), receivedAt: T0 }),
        ),
      ).toBe('recorded');
    }
  });

  it('refuses rows the application would never write, and every update and delete of the history', async () => {
    const sellerId = await seller();
    const insert = (fields: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        market_id: code,
        id: randomUUID(),
        tenant_id: market.tenantId,
        seller_id: sellerId,
        kind: 'updated',
        detected_at: '2026-10-15T10:00:00Z',
        cooling_off_until: '2026-10-16T10:00:00Z',
        source_event_id: nextEvent(),
        ...fields,
      };
      const columns = Object.keys(row);
      return sql.query(
        `INSERT INTO payments.payout_account_changes (${columns.join(', ')}) VALUES (${columns
          .map((_c, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(row),
      );
    };
    await expect(insert({ kind: 'closed' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ kind: 'initial' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ cooling_off_until: null })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ cooling_off_until: '2026-10-15T10:00:00Z' })).rejects.toMatchObject({
      code: CHECK,
    });
    await expect(insert({ source_event_id: 'ba_123' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ market_id: 'a' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ seller_id: randomUUID() })).rejects.toMatchObject({ code: FOREIGN_KEY });

    const eventId = nextEvent();
    await insert({ source_event_id: eventId });
    await expect(insert({ source_event_id: eventId })).rejects.toMatchObject({ code: UNIQUE });
    await expect(
      sql.query('UPDATE payments.payout_account_changes SET kind = $1 WHERE seller_id = $2', [
        'added',
        sellerId,
      ]),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      sql.query('DELETE FROM payments.payout_account_changes WHERE seller_id = $1', [sellerId]),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      sql.query(
        "UPDATE payments.connected_accounts SET payout_schedule_applied = 'paused' WHERE seller_id = $1",
        [sellerId],
      ),
    ).rejects.toMatchObject({ code: CHECK });
    await expect(
      sql.query(
        'UPDATE payments.connected_accounts SET payout_schedule_revision = -1 WHERE seller_id = $1',
        [sellerId],
      ),
    ).rejects.toMatchObject({ code: CHECK });
  });

  it('refuses to move the waiting period or the pause back, and clears them only once over', async () => {
    const sellerId = await seller();
    const set = (column: string, expression: string) =>
      sql.query(
        `UPDATE payments.connected_accounts SET ${column} = ${expression} WHERE seller_id = $1`,
        [sellerId],
      );
    for (const column of ['cooling_off_until', 'payouts_paused_until']) {
      // Nothing -> a value, and a value -> a later one, are allowed.
      await set(column, "now() + interval '2 days'");
      await set(column, "now() + interval '3 days'");
      // A lower value, and clearing one that is still ahead, are not.
      await expect(set(column, "now() + interval '1 day'")).rejects.toMatchObject({
        code: RESTRICT,
      });
      await expect(set(column, 'NULL')).rejects.toMatchObject({ code: RESTRICT });
      // The same value again (an update of other columns carries it along) is fine.
      await set(column, column);
    }
    // Once over, it may be cleared.
    const over = await seller();
    for (const column of ['cooling_off_until', 'payouts_paused_until']) {
      await sql.query(
        `UPDATE payments.connected_accounts SET ${column} = now() - interval '1 minute' WHERE seller_id = $1`,
        [over],
      );
      await sql.query(
        `UPDATE payments.connected_accounts SET ${column} = NULL WHERE seller_id = $1`,
        [over],
      );
    }
    // Other columns move freely while the pause stands.
    await set('payout_schedule_applied', "'manual'");
    const row = await sql.query(
      'SELECT payouts_paused_until > now() AS paused FROM payments.connected_accounts WHERE seller_id = $1',
      [sellerId],
    );
    expect(row.rows[0]).toMatchObject({ paused: true });
  });
});
