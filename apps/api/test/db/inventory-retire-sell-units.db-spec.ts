import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
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
  RetireSellUnits,
  type RetireSellUnitsInput,
} from '../../src/modules/inventory/application/use-cases/retire-sell-units.use-case';
import {
  SetStockLevel,
  type SetStockLevelInput,
} from '../../src/modules/inventory/application/use-cases/set-stock-level.use-case';
import {
  runSerializable,
  SerializableUnitRequiredError,
} from '../../src/modules/inventory/application/serializable-unit';
import { INVENTORY_EVENTS } from '../../src/modules/inventory/domain/events';
import { SellerInventory } from '../../src/modules/inventory/domain/seller-inventory';
import { ConfigInventoryPolicyProvider } from '../../src/modules/inventory/infrastructure/config-inventory-policy-provider';
import { PrismaAvailabilitySignalRepository } from '../../src/modules/inventory/infrastructure/prisma-availability-signal.repository';
import { PrismaSellerInventoryRepository } from '../../src/modules/inventory/infrastructure/prisma-seller-inventory.repository';
import { PrismaStockRepository } from '../../src/modules/inventory/infrastructure/prisma-stock.repository';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import type { HandledOnce, UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Inventory slice 2, part 4 on PostgreSQL (inventory design 3.5, 4.5; data design 3.10, 4.4, 4.5),
// for both Market fixtures, as the application role: the real repositories, the named lock
// statement, the serializable unit and the outbox writer. The catalog answer is faked (catalog
// slice 7 is not merged). The handler's unit is the real serializable unit; the inbox row and the
// delivery mark of `runOnce` are the platform's (test/db/event-delivery.db-spec.ts), so this file
// runs the handler through a `runOnce` that opens the same unit without them. Every row has fresh
// ids, so other files sharing the run database are not affected.

const T0 = Temporal.Instant.from('2026-10-09T03:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(TEST_MARKETS)('inventory.retire-sell-units in market %s (database)', (code) => {
  const other = code === 'AU' ? 'ZZ' : 'AU';
  const market = marketOf(code);
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const clock = new FixedClock(T0);
  let db: Persistence;
  let sql: Client;
  let stock: PrismaStockRepository;
  let setStockLevel: SetStockLevel;
  let retire: RetireSellUnits;
  let build: (stockRepository: StockRepository) => { set: SetStockLevel; retire: RetireSellUnits };
  const catalogOffers = new Map<Id<'Offer'>, StockOfferView>();

  /** Opens the same serializable unit as `runOnce`, without the inbox: see the header. */
  const handledOnce = (): UnitOfWork => ({
    run: (...args) => db.unitOfWork.run(...args),
    runOnce: async <T, E>(
      m: Parameters<UnitOfWork['runOnce']>[0],
      _delivery: EventDelivery,
      work: () => Promise<Result<T, E>>,
      options?: Parameters<UnitOfWork['runOnce']>[3],
    ): Promise<Result<HandledOnce<T>, E>> => {
      const done = await db.unitOfWork.run(m, work, options);
      return done.ok ? ok({ handled: true, value: done.value }) : done;
    },
  });

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
    const gate = createUseCaseGate(markets, admitAll);
    const signals = new PrismaAvailabilitySignalRepository(db.service);
    const outbox = new PrismaOutboxWriterFactory(
      modelMap,
      db.service,
      catalogue,
      ids,
      NO_PERMISSION_KEYS,
    ).forModule('inventory');
    build = (repository) => ({
      set: new SetStockLevel(gate, {
        unitOfWork: db.unitOfWork,
        inventories: new PrismaSellerInventoryRepository(db.service),
        stock: repository,
        signals,
        offers,
        policies: new ConfigInventoryPolicyProvider(markets),
        outbox,
        ids,
        clock,
      }),
      retire: new RetireSellUnits(gate, {
        unitOfWork: handledOnce(),
        stock: repository,
        signals,
        outbox,
        ids,
        clock,
      }),
    });
    ({ set: setStockLevel, retire } = build(stock));
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  const delivery = (): EventDelivery => ({
    eventId: ids.next<'event'>(),
    subscriber: 'inventory.retire-on-offer-deleted',
    attempt: 1,
  });
  const system = (marketCode = code): CallContext =>
    testCallContext(marketOf(marketCode), 'system');
  const retireOffer = (offerId: Id<'Offer'>, marketCode = code, version = 3) =>
    retire.execute(system(marketCode), {
      delivery: delivery(),
      target: { scope: 'offer', offerId },
      sourceAggregateVersion: version,
    } satisfies RetireSellUnitsInput);
  const retireVariant = (variantId: Id<'Variant'>, marketCode = code) =>
    retire.execute(system(marketCode), {
      delivery: delivery(),
      target: { scope: 'variant', variantId },
      sourceAggregateVersion: 2,
    } satisfies RetireSellUnitsInput);

  /** A seller with an inventory (one Default source) and its context, in `marketCode`. */
  async function newSeller(marketCode = code) {
    const target = marketOf(marketCode);
    const sellerId = ids.next<'Seller'>();
    const inventory = SellerInventory.createWithDefaultSource({
      id: ids.next<'SellerInventory'>(),
      defaultSourceId: ids.next<'InventorySource'>(),
      sellerId,
      marketId: target.marketId,
      now: T0,
    });
    const added = await db.unitOfWork.run(target, async () =>
      ok(await new PrismaSellerInventoryRepository(db.service).add(target, inventory)),
    );
    expect(added).toEqual({ ok: true, value: true });
    const context: CallContext = testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
    return { sellerId, context, sourceId: inventory.state.sources[0]!.id };
  }
  type Seller = Awaited<ReturnType<typeof newSeller>>;

  /** Stocks one sell unit through the real `set-stock-level`. */
  async function stockOf(
    seller: Seller,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
    onHand = 20,
    use: SetStockLevel = setStockLevel,
  ) {
    const known = catalogOffers.get(offerId);
    catalogOffers.set(offerId, {
      sellerId: seller.sellerId,
      deleted: false,
      sellUnitVariantIds: new Set([...(known?.sellUnitVariantIds ?? []), variantId]),
    });
    const input: SetStockLevelInput = {
      offerId,
      variantId,
      sourceId: seller.sourceId,
      onHand,
      expectedVersion: null,
    };
    return use.execute(seller.context, input);
  }

  const rows = async (text: string, params: unknown[]) =>
    (await sql.query<Record<string, unknown>>(text, params)).rows;
  const itemsOf = (marketCode: string, column: 'offer_id' | 'variant_id', value: string) =>
    rows(
      `SELECT id, offer_id, variant_id, retired_at, on_hand, version
         FROM inventory.stock_items WHERE market_id = $1 AND ${column} = $2 ORDER BY id`,
      [marketCode, value],
    );
  const tombstonesOf = (marketCode: string, column: 'offer_id' | 'variant_id', value: string) =>
    rows(
      `SELECT scope, offer_id, variant_id, source_aggregate_version, tenant_id
         FROM inventory.retirements WHERE market_id = $1 AND ${column} = $2`,
      [marketCode, value],
    );
  const signalEventsOf = (offerId: string) =>
    rows(
      `SELECT s.status, s.only_left, s.version, s.seller_id, o.type, o.aggregate_version
         FROM inventory.availability_signals s
         JOIN inventory.outbox o ON o.aggregate_id = s.id AND o.market_id = s.market_id
        WHERE s.market_id = $1 AND s.offer_id = $2
        ORDER BY s.variant_id, o.aggregate_version`,
      [code, offerId],
    );

  it('retires every item of the Offer, writes its tombstone and marks each sell unit out', async () => {
    const seller = await newSeller();
    const offerId = ids.next<'Offer'>();
    const untouched = ids.next<'Offer'>();
    const [v1, v2] = [ids.next<'Variant'>(), ids.next<'Variant'>()];
    await stockOf(seller, offerId, v1);
    await stockOf(seller, offerId, v2, 3);
    await stockOf(seller, untouched, v1);

    const result = await retireOffer(offerId);

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 2, sellUnits: 2 },
    });
    const retired = await itemsOf(code, 'offer_id', offerId);
    expect(retired).toHaveLength(2);
    expect(retired.every((r) => r.retired_at !== null)).toBe(true);
    expect((await itemsOf(code, 'offer_id', untouched))[0]!.retired_at).toBeNull();
    expect(await tombstonesOf(code, 'offer_id', offerId)).toEqual([
      {
        scope: 'offer',
        offer_id: offerId,
        variant_id: null,
        source_aggregate_version: 3,
        tenant_id: market.tenantId,
      },
    ]);
    const signalEvents = await signalEventsOf(offerId);
    expect(signalEvents.map((e) => [e.status, e.only_left, e.version, e.seller_id])).toEqual([
      ['out', null, expect.any(Number), seller.sellerId],
      ['out', null, expect.any(Number), seller.sellerId],
      ['out', null, expect.any(Number), seller.sellerId],
      ['out', null, expect.any(Number), seller.sellerId],
    ]);
    // Per sell unit: its set-stock-level event, then the retirement's, versions in step.
    expect(signalEvents.map((e) => e.aggregate_version)).toEqual([1, 2, 1, 2]);
  });

  it('retires the Variant across the Offers of two sellers, keyed by the Variant alone', async () => {
    const [a, b] = [await newSeller(), await newSeller()];
    const [offerA, offerB] = [ids.next<'Offer'>(), ids.next<'Offer'>()];
    const [gone, kept] = [ids.next<'Variant'>(), ids.next<'Variant'>()];
    await stockOf(a, offerA, gone);
    await stockOf(a, offerA, kept);
    await stockOf(b, offerB, gone);

    const result = await retireVariant(gone);

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 2, sellUnits: 2 },
    });
    expect((await itemsOf(code, 'variant_id', gone)).every((r) => r.retired_at !== null)).toBe(
      true,
    );
    expect((await itemsOf(code, 'variant_id', kept))[0]!.retired_at).toBeNull();
    expect(await tombstonesOf(code, 'variant_id', gone)).toEqual([
      expect.objectContaining({ scope: 'variant', offer_id: null, variant_id: gone }),
    ]);
    // The tombstone is what keeps a late stock write from re-creating the sell unit: a third
    // Offer of the same Variant is refused too, even though it never had stock.
    const late = ids.next<'Offer'>();
    const result2 = await stockOf(a, late, gone);
    expect(result2).toEqual({ ok: false, error: { code: 'inventory.not-found' } });
    expect(await itemsOf(code, 'offer_id', late)).toEqual([]);
  });

  it('records the tombstone when nothing is stocked yet, and a later first write is refused', async () => {
    const seller = await newSeller();
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();

    const result = await retireOffer(offerId);

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 0, sellUnits: 0 },
    });
    expect(await tombstonesOf(code, 'offer_id', offerId)).toHaveLength(1);
    expect(await stockOf(seller, offerId, variantId)).toEqual({
      ok: false,
      error: { code: 'inventory.not-found' },
    });
  });

  it('replays as a no-op: one tombstone, the first retired_at kept, no new event', async () => {
    const seller = await newSeller();
    const offerId = ids.next<'Offer'>();
    await stockOf(seller, offerId, ids.next<'Variant'>());
    await retireOffer(offerId, code, 3);
    const [first] = await itemsOf(code, 'offer_id', offerId);
    const eventsBefore = await signalEventsOf(offerId);
    clock.advance(Temporal.Duration.from({ seconds: 30 }));

    const again = await retireOffer(offerId, code, 4);

    expect(again).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 0, sellUnits: 0 },
    });
    const [second] = await itemsOf(code, 'offer_id', offerId);
    expect(second!.retired_at).toEqual(first!.retired_at);
    // The first tombstone stays, with the first event's version.
    expect(await tombstonesOf(code, 'offer_id', offerId)).toEqual([
      expect.objectContaining({ source_aggregate_version: 3 }),
    ]);
    expect(await signalEventsOf(offerId)).toEqual(eventsBefore);
  });

  it('leaves another Market untouched, even with the same ids', async () => {
    const mine = await newSeller();
    const theirs = await newSeller(other);
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    await stockOf(mine, offerId, variantId);
    // The same Offer and Variant ids in the other Market (the catalog fake answers by id only).
    await runSerializable(db.unitOfWork, marketOf(other), async () =>
      ok(
        await stock.insertItem(marketOf(other), {
          id: ids.next<'StockItem'>(),
          offerId,
          variantId,
          sourceId: theirs.sourceId,
          sellerId: theirs.sellerId,
          onHand: 9,
          createdAt: T0,
        }),
      ),
    );

    await retireOffer(offerId);
    await retireVariant(variantId);

    expect((await itemsOf(code, 'offer_id', offerId))[0]!.retired_at).not.toBeNull();
    expect(await tombstonesOf(other, 'offer_id', offerId)).toEqual([]);
    expect(await tombstonesOf(other, 'variant_id', variantId)).toEqual([]);
    expect((await itemsOf(other, 'offer_id', offerId)).every((r) => r.retired_at === null)).toBe(
      true,
    );
  });

  it('settles a first write racing the retirement: no active item is left for a retired Offer', async () => {
    const seller = await newSeller();
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    // Both units read the sell unit before either writes (an empty one), so each write alone
    // would be legal and together they are a write skew; SERIALIZABLE refuses one with 40001.
    let arrived = 0;
    let reads = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => (release = resolve));
    const meet = async () => {
      if (arrived >= 2) return;
      arrived += 1;
      if (arrived === 2) release();
      await together;
    };
    const wrapped: StockRepository = {
      lockSellUnit: async (...args) => {
        const found = await stock.lockSellUnit(...args);
        reads += 1;
        await meet();
        return found;
      },
      activeItemIds: async (...args) => {
        const found = await stock.activeItemIds(...args);
        reads += 1;
        await meet();
        return found;
      },
      isSellUnitRetired: (...args) => stock.isSellUnitRetired(...args),
      heldQuantities: (...args) => stock.heldQuantities(...args),
      insertItem: (...args) => stock.insertItem(...args),
      setOnHand: (...args) => stock.setOnHand(...args),
      appendMovement: (...args) => stock.appendMovement(...args),
      lockItems: (...args) => stock.lockItems(...args),
      recordTombstone: (...args) => stock.recordTombstone(...args),
      retireItems: (...args) => stock.retireItems(...args),
    };
    const racing = build(wrapped);
    catalogOffers.set(offerId, {
      sellerId: seller.sellerId,
      deleted: false,
      sellUnitVariantIds: new Set([variantId]),
    });

    const [written, retired] = await Promise.all([
      racing.set.execute(seller.context, {
        offerId,
        variantId,
        sourceId: seller.sourceId,
        onHand: 5,
        expectedVersion: null,
      }),
      racing.retire.execute(system(), {
        delivery: delivery(),
        target: { scope: 'offer', offerId },
        sourceAggregateVersion: 1,
      }),
    ]);

    expect(retired.ok).toBe(true);
    // Both read the empty sell unit, and one write was refused with 40001 and run again.
    expect(reads).toBeGreaterThan(2);
    // Whichever unit won, the retried one saw the other: either the write was refused, or the
    // item it created was retired by the retirement's retry. Never an active item.
    const items = await itemsOf(code, 'offer_id', offerId);
    expect(items.filter((i) => i.retired_at === null)).toEqual([]);
    expect(await tombstonesOf(code, 'offer_id', offerId)).toHaveLength(1);
    if (!written.ok) expect(written.error).toEqual({ code: 'inventory.not-found' });
    else expect(items).toHaveLength(1);
  });

  describe('the repository', () => {
    it('refuses its writers outside a serializable unit', async () => {
      const id = ids.next<'StockItem'>();
      await expect(
        db.unitOfWork.run(market, () => stock.lockItems(market, [id]).then((v) => ok(v))),
      ).rejects.toThrow(SerializableUnitRequiredError);
      await expect(
        db.unitOfWork.run(market, () => stock.retireItems(market, [id], T0).then((v) => ok(v))),
      ).rejects.toThrow(SerializableUnitRequiredError);
      await expect(
        db.unitOfWork.run(market, () =>
          stock
            .recordTombstone(market, {
              id: ids.next<'Retirement'>(),
              target: { scope: 'offer', offerId: ids.next<'Offer'>() },
              sourceAggregateVersion: 1,
              retiredAt: T0,
            })
            .then(() => ok(undefined)),
        ),
      ).rejects.toThrow(SerializableUnitRequiredError);
    });

    it('locks and retires more than 1,000 items in ascending batches, one way', async () => {
      const seller = await newSeller();
      const variantId = ids.next<'Variant'>();
      const count = 1001;
      const itemIds = Array.from({ length: count }, () => ids.next<'StockItem'>());
      const offerIds = Array.from({ length: count }, () => ids.next<'Offer'>());
      await sql.query(
        `INSERT INTO inventory.stock_items
           (id, market_id, tenant_id, offer_id, variant_id, source_id, seller_id, on_hand, version, created_at)
         SELECT i, $1, $2, o, $3, $4, $5, 1, 1, now()
           FROM unnest($6::uuid[], $7::uuid[]) AS t(i, o)`,
        [code, market.tenantId, variantId, seller.sourceId, seller.sellerId, itemIds, offerIds],
      );

      const result = await runSerializable(db.unitOfWork, market, async () => {
        const found = await stock.activeItemIds(market, { scope: 'variant', variantId });
        const locked = await stock.lockItems(market, found);
        const first = await stock.retireItems(market, found, T0);
        const second = await stock.retireItems(
          market,
          found,
          Temporal.Instant.from('2027-01-01T00:00:00Z'),
        );
        return ok({ found: found.length, locked: locked.length, first, second });
      });

      expect(result).toEqual({
        ok: true,
        value: { found: count, locked: count, first: count, second: 0 },
      });
      const left = await rows(
        `SELECT count(*)::int AS n, count(DISTINCT retired_at)::int AS instants
           FROM inventory.stock_items WHERE market_id = $1 AND variant_id = $2`,
        [code, variantId],
      );
      // The second call changed nothing: every item keeps the first instant.
      expect(left).toEqual([{ n: count, instants: 1 }]);
    });
  });
});
