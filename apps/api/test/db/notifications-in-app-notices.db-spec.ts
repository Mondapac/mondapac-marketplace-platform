import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { SellerNoticeScope } from '../../src/modules/notifications/application/ports/in-app-notice.repository';
import { SELLER_ORDER_PAID } from '../../src/modules/notifications/domain/in-app-notice';
import { PrismaInAppNoticeRepository } from '../../src/modules/notifications/infrastructure/prisma-in-app-notice.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The in-app notice store (notifications.in_app_notices and in_app_notice_reads) as the
// application role, in both Market fixtures: write, list, count, read per account, the cap, the
// purge with its cascade, the Market guard, and what the database refuses.

const T0 = Temporal.Instant.from('2026-10-17T10:00:00Z');
const CHECK = '23514';

describe.each(TEST_MARKETS)('in-app notice repository in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let repository: PrismaInAppNoticeRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaInAppNoticeRepository(db.service);
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
  const scopeOf = (
    sellerId: Id<'Seller'>,
    accountId: Id<'Account'>,
    since = T0.subtract({ hours: 1 }),
  ): SellerNoticeScope => ({ sellerId, accountId, kinds: [SELLER_ORDER_PAID], since });
  /** Notices one millisecond apart, so their ids sort by creation. */
  async function addNotices(target: MarketContext, sellerId: Id<'Seller'>, count: number) {
    const added: Id<'InAppNotice'>[] = [];
    for (let n = 0; n < count; n += 1) {
      clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
      const noticeId = ids.next<'InAppNotice'>();
      added.push(noticeId);
      await value(target, () =>
        repository.addForSellers(target, [
          {
            id: noticeId,
            sellerId,
            kind: SELLER_ORDER_PAID,
            params: { sellerOrderId: ids.next<'SellerOrder'>(), items: n + 1 },
            createdAt: clock.now(),
          },
        ]),
      );
    }
    return added;
  }

  it('lists newest first and pages, counts unread, and reads per account', async () => {
    const sellerId = ids.next<'Seller'>();
    const one = ids.next<'Account'>();
    const two = ids.next<'Account'>();
    const added = await addNotices(market, sellerId, 3);

    const page = await value(market, () =>
      repository.listForSeller(market, scopeOf(sellerId, one), {
        before: null,
        limit: 2,
        show: 'all',
      }),
    );
    expect(page.map((row) => row.id)).toEqual([added[2], added[1]]);
    expect(page[0]!.params).toEqual(expect.objectContaining({ items: 3 }));
    const rest = await value(market, () =>
      repository.listForSeller(market, scopeOf(sellerId, one), {
        before: added[1]!,
        limit: 2,
        show: 'all',
      }),
    );
    expect(rest.map((row) => row.id)).toEqual([added[0]]);

    expect(
      await value(market, () =>
        repository.markRead(market, one, [added[2]!, added[2]!, added[1]!], clock.now()),
      ),
    ).toBe(2);
    expect(
      await value(market, () => repository.markRead(market, one, [added[2]!], clock.now())),
    ).toBe(0);

    const mine = await value(market, () =>
      repository.unreadForSeller(market, scopeOf(sellerId, one)),
    );
    expect(mine.count).toBe(1);
    expect(mine.newest?.id).toBe(added[0]);
    const theirs = await value(market, () =>
      repository.unreadForSeller(market, scopeOf(sellerId, two)),
    );
    expect(theirs.count).toBe(3);
    expect(theirs.newest?.id).toBe(added[2]);
    expect(
      await value(market, () =>
        repository.unreadIdsForSeller(market, scopeOf(sellerId, one), 'all'),
      ),
    ).toEqual([added[0]]);
    expect(
      await value(market, () =>
        repository.existsForSeller(market, scopeOf(sellerId, one), added[2]!),
      ),
    ).toBe(true);
  });

  it('leaves out other kinds, older rows, other sellers and other Markets', async () => {
    const sellerId = ids.next<'Seller'>();
    const reader = ids.next<'Account'>();
    const [mine] = await addNotices(market, sellerId, 1);
    await addNotices(market, ids.next<'Seller'>(), 1);
    await addNotices(other, sellerId, 1);

    const none = { ...scopeOf(sellerId, reader), kinds: ['seller.other'] };
    expect(await value(market, () => repository.unreadForSeller(market, none))).toEqual({
      count: 0,
      newest: null,
    });
    const later = scopeOf(sellerId, reader, clock.now().add({ seconds: 1 }));
    expect(
      await value(market, () =>
        repository.listForSeller(market, later, { before: null, limit: 20, show: 'all' }),
      ),
    ).toEqual([]);
    const listed = await value(market, () =>
      repository.listForSeller(market, scopeOf(sellerId, reader), {
        before: null,
        limit: 20,
        show: 'all',
      }),
    );
    expect(listed.map((row) => row.id)).toEqual([mine]);
  });

  it('keeps the newest notices of a seller up to the cap', async () => {
    const sellerId = ids.next<'Seller'>();
    const added = await addNotices(market, sellerId, 5);

    expect(await value(market, () => repository.trimSeller(market, sellerId, 3))).toBe(2);
    expect(await value(market, () => repository.trimSeller(market, sellerId, 3))).toBe(0);
    const left = await value(market, () =>
      repository.listForSeller(market, scopeOf(sellerId, ids.next()), {
        before: null,
        limit: 20,
        show: 'all',
      }),
    );
    expect(left.map((row) => row.id)).toEqual([added[4], added[3], added[2]]);
  });

  it('purges old notices of this Market only, and their reads go with them', async () => {
    const sellerId = ids.next<'Seller'>();
    const reader = ids.next<'Account'>();
    const [old] = await addNotices(market, sellerId, 1);
    const [elsewhere] = await addNotices(other, sellerId, 1);
    await value(market, () => repository.markRead(market, reader, [old!], clock.now()));
    clock.advance(Temporal.Duration.from({ hours: 1 }));
    const [fresh] = await addNotices(market, sellerId, 1);

    const purged = await value(market, () =>
      repository.purgeBefore(market, clock.now().subtract({ minutes: 30 })),
    );
    expect(purged).toBeGreaterThanOrEqual(1);
    const { rows } = await sql.query<{ id: string; market_id: string }>(
      `SELECT id, market_id FROM notifications.in_app_notices WHERE id = ANY($1)`,
      [[old, elsewhere, fresh]],
    );
    expect(rows.map((row) => row.id).sort()).toEqual([elsewhere, fresh].sort());
    const reads = await sql.query(
      `SELECT 1 FROM notifications.in_app_notice_reads WHERE notice_id = $1`,
      [old],
    );
    expect(reads.rowCount).toBe(0);
  });

  it('refuses a row that breaks a CHECK', async () => {
    const insert = (audience: string, sellerId: string | null, kind: string, params: string) =>
      sql.query(
        `INSERT INTO notifications.in_app_notices
           (market_id, id, tenant_id, audience, seller_id, kind, params, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
        [code, ids.next(), market.tenantId, audience, sellerId, kind, params],
      );
    const seller = ids.next<'Seller'>();
    for (const [audience, sellerId, kind, params] of [
      ['admin', seller, SELLER_ORDER_PAID, '{}'],
      ['seller', null, SELLER_ORDER_PAID, '{}'],
      ['seller', seller, 'Seller Order', '{}'],
      ['seller', seller, SELLER_ORDER_PAID, '[]'],
      ['seller', seller, SELLER_ORDER_PAID, JSON.stringify({ x: 'y'.repeat(1100) })],
    ] as const) {
      await expect(insert(audience, sellerId, kind, params)).rejects.toMatchObject({ code: CHECK });
    }
  });
});
