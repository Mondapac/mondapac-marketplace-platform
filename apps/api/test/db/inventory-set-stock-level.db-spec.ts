import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { StockRepository } from '../../src/modules/inventory/application/ports/stock.repository';
import type {
  OfferSellUnitsSource,
  StockOfferView,
} from '../../src/modules/inventory/application/ports/offer-sell-units';
import {
  SetStockLevel,
  type SetStockLevelInput,
} from '../../src/modules/inventory/application/use-cases/set-stock-level.use-case';
import { SerializableUnitRequiredError } from '../../src/modules/inventory/application/serializable-unit';
import { INVENTORY_EVENTS } from '../../src/modules/inventory/domain/events';
import { SellerInventory } from '../../src/modules/inventory/domain/seller-inventory';
import { ConfigInventoryPolicyProvider } from '../../src/modules/inventory/infrastructure/config-inventory-policy-provider';
import { PrismaAvailabilitySignalRepository } from '../../src/modules/inventory/infrastructure/prisma-availability-signal.repository';
import { PrismaSellerInventoryRepository } from '../../src/modules/inventory/infrastructure/prisma-seller-inventory.repository';
import { PrismaStockRepository } from '../../src/modules/inventory/infrastructure/prisma-stock.repository';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  testMarketId,
} from '../support/test-config';
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Inventory slice 2, part 3 on PostgreSQL (inventory design 4.5; data design 3.4, 3.5, 3.9, 4.4,
// 4.5), for both Market fixtures, as the application role: the real repositories, the real lock,
// the serializable unit and the outbox writer, with the catalog answer faked (catalog slice 7 is
// not merged). Every row has fresh ids, so the other files sharing the run database are not
// affected.

const T0 = Temporal.Instant.from('2026-10-09T01:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(TEST_MARKETS)('inventory.set-stock-level in market %s (database)', (code) => {
  const market = marketOf(code);
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const threshold = markets.get(testMarketId(code)).inventory!.defaultLowStockThreshold;
  let db: Persistence;
  let sql: Client;
  const clock = new FixedClock(T0);
  let setStockLevel: SetStockLevel;
  let build: (repository: StockRepository) => SetStockLevel;
  /** Runs the use case, then moves the clock on so the ledger rows have distinct instants. */
  const execute = async (context: CallContext, input: SetStockLevelInput) => {
    const result = await setStockLevel.execute(context, input);
    clock.advance(Temporal.Duration.from({ seconds: 1 }));
    return result;
  };
  let stock: PrismaStockRepository;
  const catalogOffers = new Map<Id<'Offer'>, StockOfferView>();

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    const catalogue = new EventCatalogue();
    catalogue.register('inventory', INVENTORY_EVENTS);
    catalogue.seal();
    stock = new PrismaStockRepository(db.service);
    const offers: OfferSellUnitsSource = {
      sellUnitsOf: (_c, offerIds) =>
        Promise.resolve(
          new Map(
            offerIds.flatMap((id) => (catalogOffers.has(id) ? [[id, catalogOffers.get(id)!]] : [])),
          ),
        ),
    };
    build = (repository: StockRepository) =>
      new SetStockLevel(createUseCaseGate(markets, admitAll), {
        unitOfWork: db.unitOfWork,
        inventories: new PrismaSellerInventoryRepository(db.service),
        stock: repository,
        signals: new PrismaAvailabilitySignalRepository(db.service),
        offers,
        policies: new ConfigInventoryPolicyProvider(markets),
        outbox: new PrismaOutboxWriterFactory(
          modelMap,
          db.service,
          catalogue,
          ids,
          NO_PERMISSION_KEYS,
        ).forModule('inventory'),
        ids,
        clock,
      });
    setStockLevel = build(stock);
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  /** A seller with an inventory (one Default source), one Offer with one Variant, and its context. */
  async function newWorld() {
    const sellerId = ids.next<'Seller'>();
    const inventory = SellerInventory.createWithDefaultSource({
      id: ids.next<'SellerInventory'>(),
      defaultSourceId: ids.next<'InventorySource'>(),
      sellerId,
      marketId: market.marketId,
      now: T0,
    });
    const added = await db.unitOfWork.run(market, async () =>
      ok(await new PrismaSellerInventoryRepository(db.service).add(market, inventory)),
    );
    expect(added).toEqual({ ok: true, value: true });
    const accountId = ids.next<'Account'>();
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    catalogOffers.set(offerId, {
      sellerId,
      deleted: false,
      productId: ids.next<'Product'>(),
      sellUnitVariantIds: new Set([variantId]),
    });
    const sourceId = inventory.state.sources[0]!.id;
    const input = (over: Partial<SetStockLevelInput> = {}): SetStockLevelInput => ({
      offerId,
      variantId,
      sourceId,
      onHand: 20,
      expectedVersion: null,
      ...over,
    });
    return { sellerId, accountId, context, offerId, variantId, sourceId, input };
  }

  const rows = async (text: string, params: unknown[]) =>
    (await sql.query<Record<string, unknown>>(text, params)).rows;
  const itemsOf = (offerId: string) =>
    rows(
      `SELECT id, source_id, seller_id, on_hand, retired_at, version, market_id, tenant_id
         FROM inventory.stock_items WHERE market_id = $1 AND offer_id = $2 ORDER BY id`,
      [code, offerId],
    );
  const movementsOf = (offerId: string) =>
    rows(
      `SELECT delta, resulting_on_hand, reason, actor_kind, actor_account_id, actor_module,
              correlation_id, market_id, tenant_id
         FROM inventory.stock_movements WHERE market_id = $1 AND offer_id = $2
        ORDER BY occurred_at, id`,
      [code, offerId],
    );
  const signalOf = (offerId: string) =>
    rows(
      `SELECT status, only_left, version, seller_id, tenant_id
         FROM inventory.availability_signals WHERE market_id = $1 AND offer_id = $2`,
      [code, offerId],
    );
  const eventsOf = (signalId: string) =>
    rows(
      `SELECT type, aggregate_type, aggregate_version, payload, correlation_id, tenant_id
         FROM inventory.outbox WHERE market_id = $1 AND aggregate_id = $2
        ORDER BY aggregate_version`,
      [code, signalId],
    );

  it('creates the item, its ledger row, the signal and the event in one unit', async () => {
    const w = await newWorld();

    const result = await execute(w.context, w.input({ onHand: 20 }));

    expect(result).toMatchObject({ ok: true, value: { onHand: 20, version: 1, changed: true } });
    expect(await itemsOf(w.offerId)).toEqual([
      expect.objectContaining({
        source_id: w.sourceId,
        seller_id: w.sellerId,
        on_hand: 20,
        retired_at: null,
        version: 1,
        market_id: code,
        tenant_id: market.tenantId,
      }),
    ]);
    expect(await movementsOf(w.offerId)).toEqual([
      {
        delta: 20,
        resulting_on_hand: 20,
        reason: 'seller-set',
        actor_kind: 'account',
        actor_account_id: w.accountId,
        actor_module: null,
        correlation_id: w.context.correlationId,
        market_id: code,
        tenant_id: market.tenantId,
      },
    ]);
    const [signal] = await signalOf(w.offerId);
    expect(signal).toMatchObject({
      status: threshold < 20 ? 'in-stock' : 'low',
      only_left: threshold < 20 ? null : 20,
      version: 1,
      seller_id: w.sellerId,
      tenant_id: market.tenantId,
    });
  });

  it('updates the level, raises the version and appends the delta', async () => {
    const w = await newWorld();
    await execute(w.context, w.input({ onHand: 20 }));

    const result = await execute(w.context, w.input({ onHand: 12, expectedVersion: 1 }));

    expect(result).toMatchObject({ ok: true, value: { onHand: 12, version: 2, changed: true } });
    expect((await itemsOf(w.offerId))[0]).toMatchObject({ on_hand: 12, version: 2 });
    expect((await movementsOf(w.offerId)).map((m) => [m.delta, m.resulting_on_hand])).toEqual([
      [20, 20],
      [-8, 12],
    ]);
  });

  it('writes the signal events with consecutive versions, the first low entry announced once', async () => {
    const w = await newWorld();
    await execute(w.context, w.input({ onHand: threshold + 5 }));
    await execute(w.context, w.input({ onHand: threshold, expectedVersion: 1 }));
    await execute(w.context, w.input({ onHand: threshold - 1, expectedVersion: 2 }));

    const [signal] = await signalOf(w.offerId);
    const [signalRow] = await rows(
      `SELECT id FROM inventory.availability_signals WHERE market_id = $1 AND offer_id = $2`,
      [code, w.offerId],
    );
    const events = await eventsOf(signalRow!.id as string);

    expect(events.map((e) => [e.type, e.aggregate_version])).toEqual([
      ['inventory.availability-changed.v1', 1],
      ['inventory.availability-changed.v1', 2],
      ['inventory.low-stock-reached.v1', 3],
      ['inventory.availability-changed.v1', 4],
    ]);
    expect(events.every((e) => e.aggregate_type === 'availability-signal')).toBe(true);
    expect(events.every((e) => e.tenant_id === market.tenantId)).toBe(true);
    expect(signal!.version).toBe(events.length);
    expect(events[2]!.payload).toMatchObject({ sellerId: w.sellerId, onlyLeft: threshold });
  });

  it('is not a change to set the stored level: no row, no event, no version', async () => {
    const w = await newWorld();
    await execute(w.context, w.input({ onHand: 20 }));

    const result = await execute(w.context, w.input({ onHand: 20, expectedVersion: 1 }));

    expect(result).toMatchObject({ ok: true, value: { version: 1, changed: false } });
    expect(await movementsOf(w.offerId)).toHaveLength(1);
    expect((await signalOf(w.offerId))[0]!.version).toBe(1);
  });

  it('answers conflict.stale for a wrong version and writes nothing', async () => {
    const w = await newWorld();
    await execute(w.context, w.input({ onHand: 20 }));

    const result = await execute(w.context, w.input({ onHand: 5, expectedVersion: 9 }));

    expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    expect((await itemsOf(w.offerId))[0]).toMatchObject({ on_hand: 20, version: 1 });
    expect(await movementsOf(w.offerId)).toHaveLength(1);
  });

  /**
   * A use case whose lock step waits until `parties` calls have read the sell unit, so that every
   * party has seen the same state before any of them writes. Later calls (the retries of a 40001)
   * pass at once. `reads` counts the calls, retries included.
   */
  function overlapping(parties: number) {
    let arrived = 0;
    let reads = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => (release = resolve));
    const wrapped: StockRepository = {
      lockSellUnit: async (m, offerId, variantId) => {
        const found = await stock.lockSellUnit(m, offerId, variantId);
        reads += 1;
        if (arrived < parties) {
          arrived += 1;
          if (arrived === parties) release();
          await together;
        }
        return found;
      },
      isSellUnitRetired: (...args) => stock.isSellUnitRetired(...args),
      heldQuantities: (...args) => stock.heldQuantities(...args),
      insertItem: (...args) => stock.insertItem(...args),
      setOnHand: (...args) => stock.setOnHand(...args),
      appendMovement: (...args) => stock.appendMovement(...args),
      activeItemIds: (...args) => stock.activeItemIds(...args),
      lockItems: (...args) => stock.lockItems(...args),
      recordTombstone: (...args) => stock.recordTombstone(...args),
      retireItems: (...args) => stock.retireItems(...args),
      itemIdsOfOfferVariants: (...args) => stock.itemIdsOfOfferVariants(...args),
      tombstonesOf: (...args) => stock.tombstonesOf(...args),
    };
    return { useCase: build(wrapped), reads: () => reads };
  }
  const codesOf = (results: readonly { ok: boolean; error?: { code: string } }[]) =>
    results.map((r) => (r.ok ? 'ok' : r.error?.code)).sort();
  const signalEvents = async (offerId: string) => {
    const [signal] = await rows(
      `SELECT id, version FROM inventory.availability_signals WHERE market_id = $1 AND offer_id = $2`,
      [code, offerId],
    );
    const events = await eventsOf(signal!.id as string);
    return { version: signal!.version, events };
  };

  it('settles two overlapping first writes of one source: the 40001 retry finds the item, one stale', async () => {
    const w = await newWorld();
    const race = overlapping(2);

    const results = await Promise.all([
      race.useCase.execute(w.context, w.input({ onHand: 7 })),
      race.useCase.execute(w.context, w.input({ onHand: 9 })),
    ]);

    expect(codesOf(results)).toEqual(['conflict.stale', 'ok']);
    // Both read an empty sell unit; the loser's insert failed and its unit ran again.
    expect(race.reads()).toBeGreaterThan(2);
    expect(await itemsOf(w.offerId)).toHaveLength(1);
    expect(await movementsOf(w.offerId)).toHaveLength(1);
    expect(await signalOf(w.offerId)).toHaveLength(1);
  });

  it('settles two overlapping first writes of two sources: both items, one signal, versions in step', async () => {
    const w = await newWorld();
    const second = ids.next<'InventorySource'>();
    await sql.query(
      `INSERT INTO inventory.sources (id, market_id, tenant_id, seller_id, name, is_default, priority, created_at)
       VALUES ($1, $2, $3, $4, 'Second', false, 2, now())`,
      [second, code, market.tenantId, w.sellerId],
    );
    const race = overlapping(2);

    const results = await Promise.all([
      race.useCase.execute(w.context, w.input({ onHand: 30 })),
      race.useCase.execute(w.context, w.input({ onHand: 40, sourceId: second })),
    ]);

    expect(codesOf(results)).toEqual(['ok', 'ok']);
    expect(await itemsOf(w.offerId)).toHaveLength(2);
    expect(await movementsOf(w.offerId)).toHaveLength(2);
    const { version, events } = await signalEvents(w.offerId);
    expect(version).toBe(events.length);
    expect((await signalOf(w.offerId))[0]).toMatchObject({ status: 'in-stock' });
  });

  it('serialises two updates with the same expected version: one ok, one stale, no lost update', async () => {
    const w = await newWorld();
    await execute(w.context, w.input({ onHand: 50 }));
    // No barrier here: the item exists, so the second unit waits on the first one's row lock
    // (L1) and reads the raised version after it.
    const results = await Promise.all([
      execute(w.context, w.input({ onHand: 40, expectedVersion: 1 })),
      execute(w.context, w.input({ onHand: 30, expectedVersion: 1 })),
    ]);

    expect(codesOf(results)).toEqual(['conflict.stale', 'ok']);
    expect(await movementsOf(w.offerId)).toHaveLength(2);
    const [item] = await itemsOf(w.offerId);
    expect(item).toMatchObject({ version: 2 });
    const last = (await movementsOf(w.offerId)).at(-1)!;
    expect(last.resulting_on_hand).toBe(item!.on_hand);
  });

  it('refuses a retired item and a tombstone with not-found, and writes nothing', async () => {
    const w = await newWorld();
    await execute(w.context, w.input({ onHand: 20 }));
    const owner = new Client({ connectionString: testDatabaseUrl() });
    await owner.connect();
    try {
      // The application role may set `retired_at` once (data design 7); this is the handler's write.
      await owner.query(
        `UPDATE inventory.stock_items SET retired_at = now() WHERE market_id = $1 AND offer_id = $2`,
        [code, w.offerId],
      );
    } finally {
      await owner.end();
    }

    const retired = await execute(w.context, w.input({ onHand: 5, expectedVersion: 1 }));

    expect(retired).toEqual({ ok: false, error: { code: 'inventory.not-found' } });
    expect((await itemsOf(w.offerId))[0]).toMatchObject({ on_hand: 20, version: 1 });

    const v = await newWorld();
    await sql.query(
      `INSERT INTO inventory.retirements
         (id, market_id, tenant_id, scope, variant_id, source_aggregate_version, retired_at)
       VALUES ($1, $2, $3, 'variant', $4, 1, now())`,
      [ids.next(), code, market.tenantId, v.variantId],
    );
    const tombstoned = await execute(v.context, v.input());
    expect(tombstoned).toEqual({ ok: false, error: { code: 'inventory.not-found' } });
    expect(await itemsOf(v.offerId)).toEqual([]);
  });

  it('refuses every Offer of a retired Variant, even when the catalog read is stale', async () => {
    const first = await newWorld();
    const second = await newWorld();
    // The second seller's Offer also sells the first one's Variant id (the same product).
    const sharedOffer = ids.next<'Offer'>();
    catalogOffers.set(sharedOffer, {
      sellerId: second.sellerId,
      deleted: false,
      productId: ids.next<'Product'>(),
      sellUnitVariantIds: new Set([first.variantId]),
    });
    await sql.query(
      `INSERT INTO inventory.retirements
         (id, market_id, tenant_id, scope, variant_id, source_aggregate_version, retired_at)
       VALUES ($1, $2, $3, 'variant', $4, 1, now())`,
      [ids.next(), code, market.tenantId, first.variantId],
    );

    const result = await execute(
      second.context,
      second.input({ offerId: sharedOffer, variantId: first.variantId }),
    );

    expect(result).toEqual({ ok: false, error: { code: 'inventory.not-found' } });
    expect(await itemsOf(sharedOffer)).toEqual([]);
  });

  it("does not reach another Market's item with the same Offer and Variant ids", async () => {
    const w = await newWorld();
    await execute(w.context, w.input({ onHand: 20 }));
    const otherCode = code === 'AU' ? 'ZZ' : 'AU';

    const other = await sql.query(
      `SELECT 1 FROM inventory.stock_items WHERE market_id = $1 AND offer_id = $2`,
      [otherCode, w.offerId],
    );

    expect(other.rowCount).toBe(0);
  });

  it('creates an item at 0 with no ledger row, then moves it from 0 to N with version 2', async () => {
    const w = await newWorld();

    await execute(w.context, w.input({ onHand: 0 }));
    expect(await movementsOf(w.offerId)).toEqual([]);
    expect((await signalOf(w.offerId))[0]).toMatchObject({ status: 'out', only_left: null });

    const same = await execute(w.context, w.input({ onHand: 0, expectedVersion: 1 }));
    expect(same).toMatchObject({ ok: true, value: { version: 1, changed: false } });

    const raised = await execute(w.context, w.input({ onHand: 5, expectedVersion: 1 }));
    expect(raised).toMatchObject({ ok: true, value: { onHand: 5, version: 2 } });
    expect((await movementsOf(w.offerId)).map((m) => [m.delta, m.resulting_on_hand])).toEqual([
      [5, 5],
    ]);
  });

  it('answers stale for a same-level write with an old version (the version is checked first)', async () => {
    const w = await newWorld();
    await execute(w.context, w.input({ onHand: 20 }));

    const result = await execute(w.context, w.input({ onHand: 20, expectedVersion: 4 }));

    expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
  });

  it('holds the largest level and back to 0: the ledger deltas fit and the CHECKs hold', async () => {
    const w = await newWorld();
    const MAX = 2_147_483_647;

    await execute(w.context, w.input({ onHand: MAX }));
    await execute(w.context, w.input({ onHand: 0, expectedVersion: 1 }));

    expect((await movementsOf(w.offerId)).map((m) => [m.delta, m.resulting_on_hand])).toEqual([
      [MAX, MAX],
      [-MAX, 0],
    ]);
  });

  it('creates a signal directly in low with one event only (no low-stock-reached)', async () => {
    const w = await newWorld();

    await execute(w.context, w.input({ onHand: 1 }));

    const { version, events } = await signalEvents(w.offerId);
    expect(events.map((e) => e.type)).toEqual(['inventory.availability-changed.v1']);
    expect(version).toBe(1);
    expect((await signalOf(w.offerId))[0]).toMatchObject({ status: 'low', only_left: 1 });
  });

  it('takes the seller threshold of 0: never low, no count, no low-stock-reached', async () => {
    const w = await newWorld();
    await sql.query(
      `UPDATE inventory.seller_inventories SET low_stock_threshold = 0
        WHERE market_id = $1 AND seller_id = $2`,
      [code, w.sellerId],
    );

    await execute(w.context, w.input({ onHand: 1 }));
    await execute(w.context, w.input({ onHand: 2, expectedVersion: 1 }));

    expect((await signalOf(w.offerId))[0]).toMatchObject({ status: 'in-stock', only_left: null });
    const { events } = await signalEvents(w.offerId);
    expect(events.map((e) => e.type)).toEqual(['inventory.availability-changed.v1']);
  });

  it('refuses an Offer-scope tombstone as well', async () => {
    const w = await newWorld();
    await sql.query(
      `INSERT INTO inventory.retirements
         (id, market_id, tenant_id, scope, offer_id, source_aggregate_version, retired_at)
       VALUES ($1, $2, $3, 'offer', $4, 1, now())`,
      [ids.next(), code, market.tenantId, w.offerId],
    );

    expect(await execute(w.context, w.input())).toEqual({
      ok: false,
      error: { code: 'inventory.not-found' },
    });
    expect(await itemsOf(w.offerId)).toEqual([]);
  });

  it('refuses the repository writers outside a serializable unit', async () => {
    const w = await newWorld();

    const insertion = db.unitOfWork.run(market, async () => {
      await stock.insertItem(market, {
        id: ids.next<'StockItem'>(),
        offerId: w.offerId,
        variantId: w.variantId,
        sourceId: w.sourceId,
        sellerId: w.sellerId,
        onHand: 1,
        createdAt: T0,
      });
      return ok(undefined);
    });

    await expect(insertion).rejects.toBeInstanceOf(SerializableUnitRequiredError);
    expect(await itemsOf(w.offerId)).toEqual([]);
  });
});
