import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type {
  OfferSellUnitsSource,
  StockOfferView,
} from '../../src/modules/inventory/application/ports/offer-sell-units';
import { ViewOfferStock } from '../../src/modules/inventory/application/use-cases/view-offer-stock.use-case';
import { PrismaOfferStockReader } from '../../src/modules/inventory/infrastructure/prisma-offer-stock.reader';
import { PrismaSellerInventoryRepository } from '../../src/modules/inventory/infrastructure/prisma-seller-inventory.repository';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// `inventory.view-offer-stock` on PostgreSQL for both Market fixtures: the real repositories and
// the read-only unit; catalog's answer is faked. Held units come from ACTIVE unexpired and
// COMMITTED lines only; a Variant with no row answers 0 and a null version; rows of another
// Market, another seller and a tombstoned Variant stay out.

const T0 = Temporal.Instant.from('2026-10-09T01:00:00Z');
const HOUR = 3_600_000;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(TEST_MARKETS)('inventory.view-offer-stock in market %s (database)', (code) => {
  const market = marketOf(code);
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const at = (ms: number) => new Date(T0.epochMilliseconds + ms);
  const catalogOffers = new Map<Id<'Offer'>, StockOfferView>();
  let db: Persistence;
  let sql: Client;
  let view: ViewOfferStock;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    const offers: OfferSellUnitsSource = {
      sellUnitsOf: (_c, offerIds) =>
        Promise.resolve(
          new Map(
            offerIds.flatMap((id) => (catalogOffers.has(id) ? [[id, catalogOffers.get(id)!]] : [])),
          ),
        ),
    };
    view = new ViewOfferStock(createUseCaseGate(markets, admitAll), {
      unitOfWork: db.unitOfWork,
      inventories: new PrismaSellerInventoryRepository(db.service),
      offerStock: new PrismaOfferStockReader(db.service),
      offers,
      clock: new FixedClock(T0),
    });
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  async function world() {
    const sellerId = ids.next<'Seller'>();
    await sql.query(
      `INSERT INTO inventory.seller_inventories (id, market_id, tenant_id, seller_id, version, created_at)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [ids.next<'SellerInventory'>(), code, market.tenantId, sellerId, at(0)],
    );
    const sources = [ids.next<'InventorySource'>(), ids.next<'InventorySource'>()] as const;
    for (const [index, sourceId] of sources.entries()) {
      await sql.query(
        `INSERT INTO inventory.sources (id, market_id, tenant_id, seller_id, name, is_default, priority, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sourceId,
          code,
          market.tenantId,
          sellerId,
          `Source ${index + 1}`,
          index === 0,
          index + 1,
          at(0),
        ],
      );
    }
    const offerId = ids.next<'Offer'>();
    const variants = [ids.next<'Variant'>(), ids.next<'Variant'>()] as const;
    catalogOffers.set(offerId, {
      sellerId,
      deleted: false,
      productId: ids.next<'Product'>(),
      sellUnitVariantIds: new Set(variants),
    });
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
    return { sellerId, sources, offerId, variants, context };
  }

  async function item(
    w: Awaited<ReturnType<typeof world>>,
    variantId: string,
    sourceId: string,
    onHand: number,
    version = 1,
  ) {
    const id = ids.next<'StockItem'>();
    await sql.query(
      `INSERT INTO inventory.stock_items (id, market_id, tenant_id, offer_id, variant_id, source_id, seller_id, on_hand, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        code,
        market.tenantId,
        w.offerId,
        variantId,
        sourceId,
        w.sellerId,
        onHand,
        version,
        at(0),
      ],
    );
    return id;
  }

  async function line(
    w: Awaited<ReturnType<typeof world>>,
    stockItemId: string,
    variantId: string,
    quantity: number,
    state: 'active' | 'committed' | 'released',
    expiresInMs: number,
  ) {
    const reservationId = ids.next<'Reservation'>();
    const expiresAt = at(expiresInMs);
    await sql.query(
      `INSERT INTO inventory.reservations (id, market_id, tenant_id, holder_account_id, checkout_ref, status, expires_at, created_at, status_changed_at, version)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7, 1)`,
      [
        reservationId,
        code,
        market.tenantId,
        ids.next<'Account'>(),
        ids.next<'Checkout'>(),
        expiresAt,
        at(expiresInMs - 3 * HOUR),
      ],
    );
    await sql.query(
      `INSERT INTO inventory.reservation_lines (id, market_id, tenant_id, reservation_id, expires_at, offer_id, variant_id, stock_item_id, quantity, state, order_line_id, state_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        ids.next<'ReservationLine'>(),
        code,
        market.tenantId,
        reservationId,
        expiresAt,
        w.offerId,
        variantId,
        stockItemId,
        quantity,
        state,
        state === 'committed' ? ids.next<'OrderLine'>() : null,
        at(expiresInMs - 3 * HOUR),
      ],
    );
  }

  it('answers level, version and exact held units; a Variant with no row reads 0 and null', async () => {
    const w = await world();
    const [variantA, variantB] = [...w.variants].sort() as [Id<'Variant'>, Id<'Variant'>];
    const first = await item(w, variantA, w.sources[0], 20, 4);
    // Held: active unexpired 3 + committed 2 count; expired-by-time and released do not.
    await line(w, first, variantA, 3, 'active', HOUR);
    await line(w, first, variantA, 2, 'committed', -HOUR);
    await line(w, first, variantA, 5, 'active', -HOUR);
    await line(w, first, variantA, 7, 'released', HOUR);

    const result = await view.execute(w.context, { offerId: w.offerId });

    expect(result).toEqual({
      ok: true,
      value: {
        offerId: w.offerId,
        variants: [
          {
            variantId: variantA,
            sources: [
              {
                variantId: variantA,
                sourceId: w.sources[0],
                onHand: 20,
                held: 5,
                version: 4,
                retired: false,
              },
              {
                variantId: variantA,
                sourceId: w.sources[1],
                onHand: 0,
                held: 0,
                version: null,
                retired: false,
              },
            ],
          },
          {
            variantId: variantB,
            sources: [
              {
                variantId: variantB,
                sourceId: w.sources[0],
                onHand: 0,
                held: 0,
                version: null,
                retired: false,
              },
              {
                variantId: variantB,
                sourceId: w.sources[1],
                onHand: 0,
                held: 0,
                version: null,
                retired: false,
              },
            ],
          },
        ],
      },
    });
  });

  it('shows a retired item as retired, leaves out a tombstoned Variant and refuses a tombstoned Offer', async () => {
    const w = await world();
    const [variantA, variantB] = [...w.variants].sort() as [Id<'Variant'>, Id<'Variant'>];
    const retired = await item(w, variantA, w.sources[1], 1);
    await sql.query(
      `UPDATE inventory.stock_items SET retired_at = $3 WHERE market_id = $1 AND id = $2`,
      [code, retired, at(1)],
    );

    const before = await view.execute(w.context, { offerId: w.offerId });
    const cells = before.ok ? before.value.variants[0]!.sources : [];
    expect(cells[1]).toMatchObject({ onHand: 1, retired: true });

    await sql.query(
      `INSERT INTO inventory.retirements (id, market_id, tenant_id, scope, variant_id, source_aggregate_version, retired_at)
       VALUES ($1, $2, $3, 'variant', $4, 1, $5)`,
      [ids.next<'Retirement'>(), code, market.tenantId, variantB, at(2)],
    );
    const some = await view.execute(w.context, { offerId: w.offerId });
    expect(some.ok && some.value.variants.map((v) => v.variantId)).toEqual([variantA]);

    await sql.query(
      `INSERT INTO inventory.retirements (id, market_id, tenant_id, scope, offer_id, source_aggregate_version, retired_at)
       VALUES ($1, $2, $3, 'offer', $4, 1, $5)`,
      [ids.next<'Retirement'>(), code, market.tenantId, w.offerId, at(3)],
    );
    expect(await view.execute(w.context, { offerId: w.offerId })).toEqual({
      ok: false,
      error: { code: 'inventory.not-found' },
    });
  });

  it('reads nothing across sellers or Markets', async () => {
    const w = await world();
    await item(w, w.variants[0], w.sources[0], 9);
    const reader = new PrismaOfferStockReader(db.service);
    const otherCode = TEST_MARKETS.find((m) => m !== code)!;

    const here = await db.unitOfWork.run(
      market,
      async () => ({
        ok: true as const,
        value: await reader.read(market, w.sellerId, w.offerId, [...w.variants], T0),
      }),
      { readOnly: true },
    );
    const otherMarket = await db.unitOfWork.run(
      marketOf(otherCode),
      async () => ({
        ok: true as const,
        value: await reader.read(marketOf(otherCode), w.sellerId, w.offerId, [...w.variants], T0),
      }),
      { readOnly: true },
    );
    const otherSeller = await db.unitOfWork.run(
      market,
      async () => ({
        ok: true as const,
        value: await reader.read(market, ids.next<'Seller'>(), w.offerId, [...w.variants], T0),
      }),
      { readOnly: true },
    );

    expect(here.ok && here.value.items).toHaveLength(1);
    expect(otherMarket.ok && otherMarket.value.items).toEqual([]);
    expect(otherSeller.ok && otherSeller.value.items).toEqual([]);
  });
});
