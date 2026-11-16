import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PrismaCustomerReadModelRepository } from '../../src/modules/customers/infrastructure/prisma-customer-read-models.repository';
import { PrismaSellerCustomerRepository } from '../../src/modules/customers/infrastructure/prisma-seller-customers.repository';
import type { SellerCustomerSelector } from '../../src/modules/customers/domain/seller-customers';
import { PrismaStoreFollowRepository } from '../../src/modules/engagement/infrastructure/prisma-store-follow.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Customers management phase 3 as the application role, in both Market fixtures: the per-seller
// customers (a code unique per seller and kept by the upsert, the foreign key and cascade to the
// directory, the list reads scoped to one seller) and engagement's store follows (one per account
// and store, newest first, removed at erasure). Every read keeps the Markets apart.

const T0 = Temporal.Instant.from('2026-11-16T10:00:00Z');
const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const ids = new UuidV7IdGenerator(new FixedClock(T0));

const ALL: SellerCustomerSelector = {
  view: 'all',
  codePrefix: null,
  follower: null,
  lastOrderFrom: null,
  lastOrderTo: null,
  ordersMin: null,
  ordersMax: null,
  spentMin: null,
  spentMax: null,
};

/** The PostgreSQL error class of a refused write, through Prisma's error or its cause. */
const pgCode = (error: unknown): string | undefined => {
  const text = JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})) + String(error);
  if (text.includes('P2002')) return UNIQUE;
  if (text.includes('P2003')) return FOREIGN_KEY;
  return [CHECK, UNIQUE, FOREIGN_KEY].find((code) => text.includes(code));
};

describe.each(TEST_MARKETS)(
  'per-seller customers and store follows in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const currency = code === 'AU' ? 'AUD' : 'ZZD';
    let db: Persistence;
    let directory: PrismaCustomerReadModelRepository;
    let customers: PrismaSellerCustomerRepository;
    let follows: PrismaStoreFollowRepository;
    let sql: Client;

    beforeAll(async () => {
      db = createPersistence();
      directory = new PrismaCustomerReadModelRepository(db.service);
      customers = new PrismaSellerCustomerRepository(db.service);
      follows = new PrismaStoreFollowRepository(db.service);
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await db.close();
      await sql.end();
    });

    const inUnit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
      const result = await db.unitOfWork.run(target, async () => ok(await work()));
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };
    const failure = async (target: MarketContext, work: () => Promise<unknown>) => {
      try {
        await inUnit(target, work);
      } catch (error) {
        return pgCode(error);
      }
      return 'no error';
    };
    const customer = async (target: MarketContext, name: string | null) => {
      const accountId = ids.next<'Account'>();
      await inUnit(target, () =>
        directory.upsertDirectory(
          target,
          {
            accountId,
            email: `${accountId}@example.test`,
            displayName: name,
            status: 'active',
            emailVerified: true,
            signedUpAt: T0,
          },
          T0,
        ),
      );
      return accountId;
    };
    const entry = (
      sellerId: Id<'Seller'>,
      accountId: Id<'Account'>,
      over: Partial<{
        orderCount: number;
        spentMinor: bigint;
        follower: boolean;
        followedAt: Temporal.Instant | null;
        lastOrderAt: Temporal.Instant | null;
      }> = {},
    ) => {
      const orderCount = over.orderCount ?? 2;
      const follower = over.follower ?? false;
      return {
        sellerId,
        accountId,
        orderCount,
        firstOrderAt: orderCount > 0 ? T0.subtract({ hours: 240 }) : null,
        lastOrderAt: orderCount > 0 ? (over.lastOrderAt ?? T0.subtract({ hours: 2 })) : null,
        spentMinor: over.spentMinor ?? (orderCount > 0 ? 4_500n : 0n),
        currency: orderCount > 0 ? currency : null,
        follower,
        followedAt: follower ? (over.followedAt ?? T0.subtract({ hours: 1 })) : null,
      };
    };

    describe('customers.seller_customers', () => {
      it('keeps the code on a replace, and keeps codes unique per seller only', async () => {
        const shop = ids.next<'Seller'>();
        const rival = ids.next<'Seller'>();
        const alice = await customer(market, 'Maryam Rahimi');
        const bob = await customer(market, 'Omar');
        await inUnit(market, () => customers.upsert(market, entry(shop, alice), 'AAAA-0001', T0));
        await inUnit(market, () =>
          customers.upsert(market, entry(shop, alice, { orderCount: 5 }), 'ZZZZ-9999', T0),
        );
        expect(await inUnit(market, () => customers.codesOfAccount(market, alice))).toEqual(
          new Map([[shop, 'AAAA-0001']]),
        );
        expect(await inUnit(market, () => customers.codeTaken(market, shop, 'AAAA-0001'))).toBe(
          true,
        );
        expect(await inUnit(market, () => customers.codeTaken(market, rival, 'AAAA-0001'))).toBe(
          false,
        );
        // The same code at another seller is allowed; at the same seller it is refused.
        await inUnit(market, () => customers.upsert(market, entry(rival, bob), 'AAAA-0001', T0));
        expect(
          await failure(market, () => customers.upsert(market, entry(shop, bob), 'AAAA-0001', T0)),
        ).toBe(UNIQUE);
        const read = await inUnit(market, () => customers.findByCode(market, shop, 'AAAA-0001'));
        expect(read).toMatchObject({
          accountId: alice,
          firstName: 'Maryam',
          orderCount: 5,
          spent: { amount: 4_500n, currency },
        });
        expect(
          await inUnit(other, () => customers.findByCode(other, shop, 'AAAA-0001')),
        ).toBeNull();
      });

      it('refuses a row without a directory row, a bad code and a row with no relation', async () => {
        const shop = ids.next<'Seller'>();
        const ghost = ids.next<'Account'>();
        expect(
          await failure(market, () =>
            customers.upsert(market, entry(shop, ghost), 'AAAA-0002', T0),
          ),
        ).toBe(FOREIGN_KEY);
        const alice = await customer(market, 'Sam');
        expect(
          await failure(market, () =>
            customers.upsert(market, entry(shop, alice), 'aaaa-0002', T0),
          ),
        ).toBe(CHECK);
        expect(
          await failure(market, () =>
            customers.upsert(market, entry(shop, alice, { orderCount: 0 }), 'AAAA-0003', T0),
          ),
        ).toBe(CHECK);
      });

      it('goes with the directory row at erasure, and removes the sellers asked', async () => {
        const shop = ids.next<'Seller'>();
        const rival = ids.next<'Seller'>();
        const alice = await customer(market, 'Sam');
        await inUnit(market, async () => {
          await customers.upsert(market, entry(shop, alice), 'BBBB-0001', T0);
          await customers.upsert(market, entry(rival, alice), 'BBBB-0002', T0);
        });
        await inUnit(market, () => customers.removeSellers(market, alice, [rival]));
        expect([
          ...(await inUnit(market, () => customers.codesOfAccount(market, alice))).keys(),
        ]).toEqual([shop]);
        await inUnit(market, () => directory.removeAllOf(market, alice));
        const left = await sql.query(
          'SELECT 1 FROM customers.seller_customers WHERE market_id = $1 AND account_id = $2',
          [market.marketId, alice],
        );
        expect(left.rowCount).toBe(0);
      });

      it("reads one seller's list: tabs, search by code, filters, sort, counts and the trend", async () => {
        const shop = ids.next<'Seller'>();
        const rival = ids.next<'Seller'>();
        const buyer = await customer(market, 'Maryam Rahimi');
        const fan = await customer(market, 'Omar');
        const both = await customer(market, null);
        await inUnit(market, async () => {
          await customers.upsert(
            market,
            entry(shop, buyer, { orderCount: 3, spentMinor: 9_000n }),
            'CCCC-0001',
            T0,
          );
          await customers.upsert(
            market,
            entry(shop, fan, { orderCount: 0, follower: true }),
            'CCCC-0002',
            T0,
          );
          await customers.upsert(
            market,
            entry(shop, both, {
              orderCount: 1,
              spentMinor: 500n,
              follower: true,
              lastOrderAt: T0.subtract({ hours: 30 }),
            }),
            'DDDD-0003',
            T0,
          );
          await customers.upsert(market, entry(rival, buyer), 'CCCC-0001', T0);
        });
        const query = (selector: Partial<SellerCustomerSelector>) => ({
          sellerId: shop,
          selector: { ...ALL, ...selector },
        });
        const page = (selector: Partial<SellerCustomerSelector>, sort = 'code' as const) =>
          inUnit(market, () =>
            customers.page(
              market,
              query(selector),
              { sort, direction: 'asc' },
              { offset: 0, limit: 10 },
            ),
          );
        expect((await page({})).map((row) => row.code)).toEqual([
          'CCCC-0001',
          'CCCC-0002',
          'DDDD-0003',
        ]);
        expect((await page({ view: 'buyers' })).map((row) => row.code)).toEqual([
          'CCCC-0001',
          'DDDD-0003',
        ]);
        expect((await page({ view: 'followers' })).map((row) => row.code)).toEqual([
          'CCCC-0002',
          'DDDD-0003',
        ]);
        expect((await page({ codePrefix: 'CCCC' })).map((row) => row.code)).toEqual([
          'CCCC-0001',
          'CCCC-0002',
        ]);
        expect((await page({ spentMin: 1_000n })).map((row) => row.code)).toEqual(['CCCC-0001']);
        expect((await page({ ordersMin: 1, ordersMax: 1 })).map((row) => row.code)).toEqual([
          'DDDD-0003',
        ]);
        const day = T0.toString().slice(0, 10);
        expect(
          (await page({ lastOrderFrom: day, lastOrderTo: day })).map((row) => row.code),
        ).toEqual(['CCCC-0001']);
        expect(
          (
            await inUnit(market, () =>
              customers.page(
                market,
                query({}),
                { sort: 'spent', direction: 'desc' },
                { offset: 0, limit: 1 },
              ),
            )
          ).map((row) => row.code),
        ).toEqual(['CCCC-0001']);
        expect(await inUnit(market, () => customers.count(market, query({ view: 'buyers' })))).toBe(
          2,
        );
        expect(await inUnit(market, () => customers.tabCounts(market, shop))).toEqual({
          all: 3,
          buyers: 2,
          followers: 2,
        });
        expect(
          (
            await inUnit(market, () =>
              customers.findByCodes(market, shop, ['DDDD-0003', 'NONE-0000', 'CCCC-0001']),
            )
          ).map((row) => row.code),
        ).toEqual(['DDDD-0003', 'CCCC-0001']);
        const monthly = await inUnit(market, () =>
          customers.monthly(market, shop, [
            { month: 'window', from: T0.subtract({ hours: 300 }), to: T0.add({ hours: 1 }) },
          ]),
        );
        expect(monthly).toEqual([{ month: 'window', newBuyers: 2, newFollowers: 2 }]);
        expect(await inUnit(other, () => customers.tabCounts(other, shop))).toEqual({
          all: 0,
          buyers: 0,
          followers: 0,
        });
      });
    });

    describe('engagement.store_follows', () => {
      it('stores one follow per account and store, newest first, and removes it', async () => {
        const account = ids.next<'Account'>();
        const [first, second] = [ids.next<'Seller'>(), ids.next<'Seller'>()];
        const follow = (sellerId: Id<'Seller'>, at: Temporal.Instant) => ({
          id: ids.next<'StoreFollow'>(),
          accountId: account,
          sellerId,
          followedAt: at,
        });
        const a = follow(first, T0);
        const b = follow(second, T0.add({ hours: 1 }));
        expect(await inUnit(market, () => follows.insert(market, a))).toBe('inserted');
        expect(await inUnit(market, () => follows.insert(market, b))).toBe('inserted');
        expect(await inUnit(market, () => follows.insert(market, follow(first, T0)))).toBe(
          'exists',
        );
        expect(await inUnit(market, () => follows.countOf(market, account))).toBe(2);
        expect(
          (await inUnit(market, () => follows.pageOf(market, account, null, 10))).map(
            (f) => f.sellerId,
          ),
        ).toEqual([second, first]);
        expect(
          (
            await inUnit(market, () =>
              follows.pageOf(market, account, { followedAt: b.followedAt, id: b.id }, 10),
            )
          ).map((f) => f.sellerId),
        ).toEqual([first]);
        expect(
          (
            await inUnit(market, () =>
              follows.followedAmong(market, account, [first, ids.next<'Seller'>()]),
            )
          ).map((f) => f.sellerId),
        ).toEqual([first]);
        expect(await inUnit(other, () => follows.allOf(other, account))).toEqual([]);
        expect(await inUnit(market, () => follows.remove(market, account, a.id))).toBe(true);
        expect(await inUnit(market, () => follows.remove(market, account, a.id))).toBe(false);
        expect(await inUnit(market, () => follows.deleteForAccount(market, account))).toBe(1);
        expect(await inUnit(market, () => follows.allOf(market, account))).toEqual([]);
      });
    });
  },
);
