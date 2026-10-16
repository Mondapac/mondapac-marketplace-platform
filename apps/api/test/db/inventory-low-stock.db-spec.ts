import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { SellUnitLabelsSource } from '../../src/modules/inventory/application/ports/sell-unit-labels';
import { ListLowStock } from '../../src/modules/inventory/application/use-cases/list-low-stock.use-case';
import { PrismaOfferStockReader } from '../../src/modules/inventory/infrastructure/prisma-offer-stock.reader';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// `inventory.list-low-stock` on PostgreSQL for both Market fixtures: the real reader and the
// read-only unit; catalog's labels are faked. Only the seller's own `low` and `out` signals of
// this Market appear, most recently changed first; a sell unit whose items are all retired stays
// out; the cursor pages without gaps or repeats.

const T0 = Temporal.Instant.from('2026-10-16T01:00:00Z');
const MINUTE = 60_000;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(TEST_MARKETS)('inventory.list-low-stock in market %s (database)', (code) => {
  const market = marketOf(code);
  const otherCode = TEST_MARKETS.find((m) => m !== code)!;
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const at = (ms: number) => new Date(T0.epochMilliseconds + ms);
  let db: Persistence;
  let sql: Client;
  let list: ListLowStock;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    const labels: SellUnitLabelsSource = { labelsOf: () => Promise.resolve(new Map()) };
    list = new ListLowStock(createUseCaseGate(markets, admitAll), {
      unitOfWork: db.unitOfWork,
      offerStock: new PrismaOfferStockReader(db.service),
      labels,
    });
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  async function seller(marketId: typeof code = code) {
    const tenantId = marketOf(marketId).tenantId;
    const sellerId = ids.next<'Seller'>();
    const sourceId = ids.next<'InventorySource'>();
    await sql.query(
      `INSERT INTO inventory.seller_inventories (id, market_id, tenant_id, seller_id, version, created_at)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [ids.next<'SellerInventory'>(), marketId, tenantId, sellerId, at(0)],
    );
    await sql.query(
      `INSERT INTO inventory.sources (id, market_id, tenant_id, seller_id, name, is_default, priority, created_at)
       VALUES ($1, $2, $3, $4, 'Main', true, 1, $5)`,
      [sourceId, marketId, tenantId, sellerId, at(0)],
    );
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
    return { sellerId, sourceId, marketId, tenantId, context };
  }

  /** A sell unit with one stock item (retired or not) and its signal. */
  async function unit(
    s: Awaited<ReturnType<typeof seller>>,
    status: 'in-stock' | 'low' | 'out',
    minutesAgo: number,
    retired = false,
  ) {
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
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
        status === 'out' ? 0 : 2,
        at(0),
        retired ? at(0) : null,
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
        at(-minutesAgo * MINUTE),
      ],
    );
    return offerId;
  }

  it('lists only the seller’s own low and out sell units, latest change first, and pages', async () => {
    const s = await seller();
    const stranger = await seller();
    const abroad = await seller(otherCode);
    const newest = await unit(s, 'low', 1);
    await unit(s, 'in-stock', 2);
    const middle = await unit(s, 'out', 3);
    await unit(s, 'out', 4, true);
    const oldest = await unit(s, 'low', 5);
    await unit(stranger, 'low', 1);
    await unit(abroad, 'low', 1);

    const all = await list.execute(s.context, {});
    expect(all.ok && all.value.items.map((item) => item.offerId)).toEqual([newest, middle, oldest]);
    expect(all.ok && all.value.items[0]).toMatchObject({ status: 'low', onlyLeft: 2 });

    const out = await list.execute(s.context, { status: 'out' });
    expect(out.ok && out.value.items.map((item) => item.offerId)).toEqual([middle]);

    const first = await list.execute(s.context, { limit: 2 });
    expect(first.ok && first.value.items.map((item) => item.offerId)).toEqual([newest, middle]);
    const cursor = first.ok ? first.value.nextCursor : null;
    expect(cursor).not.toBeNull();
    // The retired sell unit is skipped on the second page; the page ends the list.
    const second = await list.execute(s.context, { limit: 2, cursor });
    expect(second.ok && second.value.items.map((item) => item.offerId)).toEqual([oldest]);
    expect(second.ok && second.value.nextCursor).toBeNull();
  });
});
