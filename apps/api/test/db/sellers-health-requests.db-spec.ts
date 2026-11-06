import { Temporal, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SellerFile } from '../../src/modules/sellers/domain/seller-file';
import { PrismaSellerFileRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-file.repository';
import { PrismaSellerHealthRequestStore } from '../../src/modules/sellers/infrastructure/prisma-seller-health-request.store';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The seller health request store on PostgreSQL, for both Market fixtures, as the application
// role: one pending request per seller, a finished request lets the next click through, the
// oldest request comes first, Markets stay apart, and the CHECKs and grants hold.

const T0 = Temporal.Instant.from('2026-11-10T01:00:00Z');

describe.each(TEST_MARKETS)('the seller health request store in market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let sql: Client;
  let files: PrismaSellerFileRepository;
  let store: PrismaSellerHealthRequestStore;

  beforeAll(async () => {
    db = createPersistence();
    files = new PrismaSellerFileRepository(db.service);
    store = new PrismaSellerHealthRequestStore(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  async function newSeller(m: MarketContext = market): Promise<Id<'Seller'>> {
    clock.advance(Temporal.Duration.from({ milliseconds: 2 }));
    const sellerId = ids.next<'Seller'>();
    const created = await db.unitOfWork.run(m, async () =>
      ok(
        await files.addWithRoots(
          m,
          SellerFile.create({
            sellerId,
            marketId: m.marketId,
            origin: 'self',
            approvalRequiredAtRegistration: true,
            now: T0,
          }),
        ),
      ),
    );
    if (!created.ok) throw new Error('unreachable');
    return sellerId;
  }

  const run = <T>(m: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork
      .run(m, async () => ok(await work()))
      .then((r) => {
        if (!r.ok) throw new Error('unit failed');
        return r.value;
      });

  const enqueue = (
    m: MarketContext,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant = T0,
    source: 'admin' | 'seller' = 'admin',
  ) =>
    run(m, () =>
      store.enqueue(m, {
        id: ids.next(),
        sellerId,
        source,
        byAccountId: ids.next<'Account'>(),
        at,
      }),
    );

  it('queues one pending request per seller and refuses a second click', async () => {
    const seller = await newSeller();
    expect(await enqueue(market, seller)).toEqual({ queued: true });
    expect(await enqueue(market, seller)).toEqual({ queued: false });
    const mine = (await run(market, () => store.pending(market, 100))).filter(
      (r) => r.sellerId === seller,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.status).toBe('pending');
  });

  it('lets the next click through once the request is finished', async () => {
    const seller = await newSeller();
    await enqueue(market, seller);
    const first = (await run(market, () => store.latest(market, seller)))!;
    expect(await run(market, () => store.finish(market, first.id, 'done', T0))).toBe(true);
    expect(await run(market, () => store.finish(market, first.id, 'failed', T0))).toBe(false);
    expect((await run(market, () => store.latest(market, seller)))?.status).toBe('done');
    expect(await enqueue(market, seller, T0.add({ minutes: 5 }))).toEqual({ queued: true });
    expect((await run(market, () => store.latest(market, seller)))?.status).toBe('pending');
  });

  it('gives the oldest pending request first and honours the page size', async () => {
    const a = await newSeller();
    const b = await newSeller();
    await enqueue(market, b, T0.add({ minutes: 2 }));
    await enqueue(market, a, T0.add({ minutes: 1 }));
    const page = await run(market, () => store.pending(market, 100));
    const order = page.map((r) => r.sellerId).filter((s) => s === a || s === b);
    expect(order).toEqual([a, b]);
    expect(await run(market, () => store.pending(market, 1))).toHaveLength(1);
    await expect(run(market, () => store.pending(market, 0))).rejects.toThrow(RangeError);
    await expect(run(market, () => store.pending(market, 101))).rejects.toThrow(RangeError);
  });

  it("finds the latest request of one source, so an admin click never counts as the seller's", async () => {
    const seller = await newSeller();
    await enqueue(market, seller, T0, 'seller');
    const first = (await run(market, () => store.latest(market, seller, 'seller')))!;
    await run(market, () => store.finish(market, first.id, 'done', T0));
    await enqueue(market, seller, T0.add({ minutes: 20 }), 'admin');
    expect((await run(market, () => store.latest(market, seller)))?.source).toBe('admin');
    const own = await run(market, () => store.latest(market, seller, 'seller'));
    expect(own).toMatchObject({ id: first.id, source: 'seller' });
    const other = await newSeller();
    await enqueue(market, other, T0, 'admin');
    expect(await run(market, () => store.latest(market, other, 'seller'))).toBeNull();
  });

  it('keeps Markets apart', async () => {
    const seller = await newSeller();
    await enqueue(market, seller);
    expect(await run(other, () => store.latest(other, seller))).toBeNull();
    const there = await run(other, () => store.pending(other, 100));
    expect(there.some((r) => r.sellerId === seller)).toBe(false);
  });

  it('refuses a bad source or status and a pending row with a finish time', async () => {
    const seller = await newSeller();
    const insert = (source: string, status: string, finished: string | null) =>
      sql.query(
        `INSERT INTO sellers.seller_health_requests
           (id, market_id, tenant_id, seller_id, source, requested_by_account_id, requested_at, status, finished_at)
         SELECT $1, market_id, tenant_id, seller_id, $2, $3, now(), $4, $5
           FROM sellers.seller_files WHERE seller_id = $6 AND market_id = $7`,
        [ids.next(), source, ids.next(), status, finished, seller, market.marketId],
      );
    await expect(insert('robot', 'pending', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('admin', 'weird', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('admin', 'pending', new Date().toISOString())).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert('admin', 'done', null)).rejects.toMatchObject({ code: '23514' });
  });
});
