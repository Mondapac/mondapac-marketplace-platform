import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AdminOutOfStockVariants } from '../../src/modules/inventory/application/use-cases/admin-out-of-stock-variants.use-case';
import { PrismaVariantStockReader } from '../../src/modules/inventory/infrastructure/prisma-variant-stock.reader';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// `inventory.admin-out-of-stock-variants` on PostgreSQL for both Market fixtures: a Variant counts
// only when it has a live sell unit and every sell unit of it is `out`; other Markets and retired
// sell units stay out; the cursor pages without gaps or repeats.

const T0 = Temporal.Instant.from('2026-10-16T01:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(TEST_MARKETS)(
  'inventory.admin-out-of-stock-variants in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const otherCode = TEST_MARKETS.find((m) => m !== code)!;
    const ids = new UuidV7IdGenerator(new FixedClock(T0));
    const at = new Date(T0.epochMilliseconds);
    let db: Persistence;
    let sql: Client;
    let run: AdminOutOfStockVariants;

    const admin = (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );

    beforeAll(async () => {
      db = createPersistence();
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
      run = new AdminOutOfStockVariants(createUseCaseGate(markets, admitAll), {
        unitOfWork: db.unitOfWork,
        variantStock: new PrismaVariantStockReader(db.service),
      });
    });
    afterAll(async () => {
      await db.close();
      await sql.end();
    });

    async function seller(marketId: typeof code) {
      const tenantId = marketOf(marketId).tenantId;
      const sellerId = ids.next<'Seller'>();
      const sourceId = ids.next<'InventorySource'>();
      await sql.query(
        `INSERT INTO inventory.seller_inventories (id, market_id, tenant_id, seller_id, version, created_at)
       VALUES ($1, $2, $3, $4, 1, $5)`,
        [ids.next<'SellerInventory'>(), marketId, tenantId, sellerId, at],
      );
      await sql.query(
        `INSERT INTO inventory.sources (id, market_id, tenant_id, seller_id, name, is_default, priority, created_at)
       VALUES ($1, $2, $3, $4, 'Main', true, 1, $5)`,
        [sourceId, marketId, tenantId, sellerId, at],
      );
      return { sellerId, sourceId, marketId, tenantId };
    }

    /** One sell unit of `variantId` with a stock item (retired or not) and its signal. */
    async function unit(
      s: Awaited<ReturnType<typeof seller>>,
      variantId: string,
      status: 'in-stock' | 'low' | 'out',
      retired = false,
    ) {
      const offerId = ids.next<'Offer'>();
      await sql.query(
        `INSERT INTO inventory.stock_items (id, market_id, tenant_id, offer_id, variant_id, source_id, seller_id, on_hand, version, created_at, retired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10)`,
        [
          ids.next<'StockItem'>(),
          s.marketId,
          s.tenantId,
          offerId,
          variantId,
          s.sourceId,
          s.sellerId,
          status === 'out' ? 0 : 5,
          at,
          retired ? at : null,
        ],
      );
      await sql.query(
        `INSERT INTO inventory.availability_signals (id, market_id, tenant_id, offer_id, variant_id, seller_id, status, only_left, changed_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)`,
        [
          ids.next<'AvailabilitySignal'>(),
          s.marketId,
          s.tenantId,
          offerId,
          variantId,
          s.sellerId,
          status,
          status === 'low' ? 2 : null,
          at,
        ],
      );
    }

    it('counts a Variant only when it has a live sell unit and all of them are out, and pages', async () => {
      // Rows of the other Market's run stay in the database: count from a baseline.
      const before = await run.execute(admin(), { limit: 500 });
      const baseline = before.ok ? before.value.variantIds : [];
      const a = await seller(code);
      const b = await seller(code);
      const abroad = await seller(otherCode);
      const allOut = ids.next<'Variant'>();
      const twoSellersOut = ids.next<'Variant'>();
      const oneSellerHasStock = ids.next<'Variant'>();
      const oneLow = ids.next<'Variant'>();
      const retiredOnly = ids.next<'Variant'>();
      const retiredPlusOut = ids.next<'Variant'>();
      const foreign = ids.next<'Variant'>();
      await unit(a, allOut, 'out');
      await unit(a, twoSellersOut, 'out');
      await unit(b, twoSellersOut, 'out');
      await unit(a, oneSellerHasStock, 'out');
      await unit(b, oneSellerHasStock, 'in-stock');
      await unit(a, oneLow, 'low');
      await unit(a, retiredOnly, 'out', true);
      await unit(a, retiredPlusOut, 'out', true);
      await unit(b, retiredPlusOut, 'out');
      await unit(abroad, foreign, 'out');

      const expected = [...baseline, allOut, twoSellersOut, retiredPlusOut].sort();
      const all = await run.execute(admin(), {});
      expect(all.ok && all.value.variantIds).toEqual(expected);
      expect(all.ok && all.value.total).toBe(expected.length);
      expect(all.ok && all.value.nextCursor).toBeNull();

      const first = await run.execute(admin(), { limit: expected.length - 1 });
      expect(first.ok && first.value.variantIds).toEqual(expected.slice(0, expected.length - 1));
      expect(first.ok && first.value.nextCursor).toBe(expected[expected.length - 2]);
      expect(first.ok && first.value.total).toBe(expected.length);
      const second = await run.execute(admin(), {
        limit: expected.length - 1,
        cursor: expected[expected.length - 2],
      });
      expect(second.ok && second.value.variantIds).toEqual(expected.slice(expected.length - 1));
      expect(second.ok && second.value.nextCursor).toBeNull();
    });

    it('walks several batches, and leaves out a live item that has no signal yet', async () => {
      const small = new AdminOutOfStockVariants(createUseCaseGate(markets, admitAll), {
        unitOfWork: db.unitOfWork,
        variantStock: new PrismaVariantStockReader(db.service, 2),
      });
      const before = await small.execute(admin(), { limit: 500 });
      const baseline = before.ok ? before.value.variantIds : [];
      const s = await seller(code);
      const matching: string[] = [];
      // Interleave matching and blocked Variants so that some batches hold no match at all.
      for (let i = 0; i < 4; i += 1) {
        const blocked = ids.next<'Variant'>();
        await unit(s, blocked, 'out');
        await unit(await seller(code), blocked, 'in-stock');
      }
      for (let i = 0; i < 5; i += 1) {
        const v = ids.next<'Variant'>();
        await unit(s, v, 'out');
        matching.push(v);
      }
      // A live stock item with no availability signal row: never a candidate.
      const noSignal = ids.next<'Variant'>();
      await sql.query(
        `INSERT INTO inventory.stock_items (id, market_id, tenant_id, offer_id, variant_id, source_id, seller_id, on_hand, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 1, $8)`,
        [
          ids.next<'StockItem'>(),
          s.marketId,
          s.tenantId,
          ids.next<'Offer'>(),
          noSignal,
          s.sourceId,
          s.sellerId,
          at,
        ],
      );
      const expected = [...baseline, ...matching].sort();
      const all = await small.execute(admin(), { limit: 500 });
      expect(all.ok && all.value.variantIds).toEqual(expected);
      expect(all.ok && all.value.total).toBe(expected.length);
      const page = await small.execute(admin(), { limit: 3, cursor: expected[2] });
      expect(page.ok && page.value.variantIds).toEqual(expected.slice(3, 6));
    });
  },
);
