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
import { ViewOffersStock } from '../../src/modules/inventory/application/use-cases/view-offers-stock.use-case';
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

// `inventory.view-offers-stock` (Offer page PR 8) on PostgreSQL for both Market fixtures: the
// real repositories, `readMany` and the read-only unit; catalog's answer is faked. Each Offer of
// the batch answers exactly what `inventory.view-offer-stock` answers for it alone (held units,
// retired items, tombstones), and rows of another Market or another seller stay out.

const T0 = Temporal.Instant.from('2026-10-09T01:00:00Z');
const HOUR = 3_600_000;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(TEST_MARKETS)('inventory.view-offers-stock in market %s (database)', (code) => {
  const market = marketOf(code);
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const at = (ms: number) => new Date(T0.epochMilliseconds + ms);
  const catalogOffers = new Map<Id<'Offer'>, StockOfferView>();
  let db: Persistence;
  let sql: Client;
  let view: ViewOfferStock;
  let many: ViewOffersStock;

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
    const deps = {
      unitOfWork: db.unitOfWork,
      inventories: new PrismaSellerInventoryRepository(db.service),
      offerStock: new PrismaOfferStockReader(db.service),
      offers,
      clock: new FixedClock(T0),
    };
    view = new ViewOfferStock(createUseCaseGate(markets, admitAll), deps);
    many = new ViewOffersStock(createUseCaseGate(markets, admitAll), deps);
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

  /** Another Offer of the same seller, with its own two Variants. */
  function another(w: Awaited<ReturnType<typeof world>>) {
    const offerId = ids.next<'Offer'>();
    const variants = [ids.next<'Variant'>(), ids.next<'Variant'>()] as const;
    catalogOffers.set(offerId, {
      sellerId: w.sellerId,
      deleted: false,
      productId: ids.next<'Product'>(),
      sellUnitVariantIds: new Set(variants),
    });
    return { ...w, offerId, variants };
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

  it('answers each Offer of the batch exactly as the one-Offer read does', async () => {
    const w = await world();
    const w2 = another(w);
    const w3 = another(w);
    const first = await item(w, w.variants[0], w.sources[0], 20, 4);
    await line(w, first, w.variants[0], 3, 'active', HOUR);
    await line(w, first, w.variants[0], 2, 'committed', -HOUR);
    await line(w, first, w.variants[0], 5, 'active', -HOUR);
    await item(w2, w2.variants[1], w2.sources[1], 7, 2);
    const retired = await item(w2, w2.variants[0], w2.sources[0], 1);
    await sql.query(
      `UPDATE inventory.stock_items SET retired_at = $3 WHERE market_id = $1 AND id = $2`,
      [code, retired, at(1)],
    );
    await sql.query(
      `INSERT INTO inventory.retirements (id, market_id, tenant_id, scope, variant_id, source_aggregate_version, retired_at)
       VALUES ($1, $2, $3, 'variant', $4, 1, $5)`,
      [ids.next<'Retirement'>(), code, market.tenantId, w3.variants[1], at(2)],
    );

    const result = await many.execute(w.context, {
      offerIds: [w3.offerId, w.offerId, w2.offerId].join(','),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.offers.map((offer) => offer.offerId)).toEqual([
      w3.offerId,
      w.offerId,
      w2.offerId,
    ]);
    for (const offer of result.value.offers) {
      expect(await view.execute(w.context, { offerId: offer.offerId })).toEqual({
        ok: true,
        value: offer,
      });
    }
    expect(result.value.offers[1]?.variants.flatMap((v) => v.sources)).toContainEqual(
      expect.objectContaining({ onHand: 20, held: 5, version: 4 }),
    );
    expect(result.value.offers[0]?.variants.map((v) => v.variantId)).toEqual([w3.variants[0]]);
  });

  it('leaves out a tombstoned Offer of the batch', async () => {
    const w = await world();
    const w2 = another(w);
    await sql.query(
      `INSERT INTO inventory.retirements (id, market_id, tenant_id, scope, offer_id, source_aggregate_version, retired_at)
       VALUES ($1, $2, $3, 'offer', $4, 1, $5)`,
      [ids.next<'Retirement'>(), code, market.tenantId, w2.offerId, at(3)],
    );

    const result = await many.execute(w.context, { offerIds: `${w.offerId},${w2.offerId}` });

    expect(result.ok && result.value.offers.map((offer) => offer.offerId)).toEqual([w.offerId]);
  });

  it('reads nothing across sellers or Markets', async () => {
    const w = await world();
    const w2 = another(w);
    await item(w, w.variants[0], w.sources[0], 9);
    await item(w2, w2.variants[0], w2.sources[1], 4);
    const reader = new PrismaOfferStockReader(db.service);
    const otherCode = TEST_MARKETS.find((m) => m !== code)!;
    const asked = [
      { offerId: w.offerId, variantIds: [...w.variants] },
      { offerId: w2.offerId, variantIds: [...w2.variants] },
    ];
    const readAs = (marketCode: string, sellerId: Id<'Seller'>) =>
      db.unitOfWork.run(
        marketOf(marketCode),
        async () => ({
          ok: true as const,
          value: await reader.readMany(marketOf(marketCode), sellerId, asked, T0),
        }),
        { readOnly: true },
      );

    const here = await readAs(code, w.sellerId);
    const otherMarket = await readAs(otherCode, w.sellerId);
    const otherSeller = await readAs(code, ids.next<'Seller'>());

    const count = (r: typeof here) =>
      r.ok ? [...r.value.values()].map((snapshot) => snapshot.items.length) : [];
    expect(count(here)).toEqual([1, 1]);
    expect(count(otherMarket)).toEqual([0, 0]);
    expect(count(otherSeller)).toEqual([0, 0]);
  });
});
