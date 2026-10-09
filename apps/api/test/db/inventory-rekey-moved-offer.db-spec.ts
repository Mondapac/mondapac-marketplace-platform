import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { runSerializable } from '../../src/modules/inventory/application/serializable-unit';
import type { StockRepository } from '../../src/modules/inventory/application/ports/stock.repository';
import type {
  OfferSellUnitsSource,
  StockOfferView,
} from '../../src/modules/inventory/application/ports/offer-sell-units';
import {
  RekeyMovedOffer,
  type RekeyMovedOfferInput,
} from '../../src/modules/inventory/application/use-cases/rekey-moved-offer.use-case';
import { RetireSellUnits } from '../../src/modules/inventory/application/use-cases/retire-sell-units.use-case';
import {
  SetStockLevel,
  type SetStockLevelInput,
} from '../../src/modules/inventory/application/use-cases/set-stock-level.use-case';
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
import {
  createPersistence,
  marketOf,
  modelMap,
  retryingConflicts,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Inventory slice 2, part 5 on PostgreSQL (inventory design 3.6; data design 3.5, 4.4, 4.5),
// for both Market fixtures, as the application role: the real repositories, the named lock
// statement, the serializable unit and the outbox writer. The catalog answer is faked (catalog
// slice 7 is not merged). The handler's unit is the real serializable unit; the inbox row and the
// delivery mark of `runOnce` are the platform's (test/db/event-delivery.db-spec.ts), so this file
// runs the handler through a `runOnce` that opens the same unit without them. Every row has fresh
// ids, so other files sharing the run database are not affected. The reservation steps of the
// re-key join with slice 4, when the reservation tables exist.

const T0 = Temporal.Instant.from('2026-10-09T03:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(TEST_MARKETS)('inventory.rekey-moved-offer in market %s (database)', (code) => {
  const other = code === 'AU' ? 'ZZ' : 'AU';
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const clock = new FixedClock(T0);
  let db: Persistence;
  let sql: Client;
  let stock: PrismaStockRepository;
  let setStockLevel: SetStockLevel;
  let retire: RetireSellUnits;
  let rekey: RekeyMovedOffer;
  let build: (stockRepository: StockRepository) => { set: SetStockLevel; rekey: RekeyMovedOffer };
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
    const inventories = new PrismaSellerInventoryRepository(db.service);
    const policies = new ConfigInventoryPolicyProvider(markets);
    const outbox = new PrismaOutboxWriterFactory(
      modelMap,
      db.service,
      catalogue,
      ids,
      NO_PERMISSION_KEYS,
    ).forModule('inventory');
    build = (repository) => ({
      set: retryingConflicts(
        new SetStockLevel(gate, {
          unitOfWork: db.unitOfWork,
          inventories,
          stock: repository,
          signals,
          offers,
          policies,
          outbox,
          ids,
          clock,
        }),
      ),
      rekey: retryingConflicts(
        new RekeyMovedOffer(gate, {
          unitOfWork: handledOnce(),
          inventories,
          stock: repository,
          signals,
          offers,
          policies,
          outbox,
          ids,
          clock,
        }),
      ),
    });
    ({ set: setStockLevel, rekey } = build(stock));
    retire = retryingConflicts(
      new RetireSellUnits(gate, {
        unitOfWork: handledOnce(),
        stock,
        signals,
        outbox,
        ids,
        clock,
      }),
    );
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  const delivery = (): EventDelivery => ({
    eventId: ids.next<'event'>(),
    subscriber: 'inventory.rekey-on-offer-moved',
    attempt: 1,
  });
  const system = (marketCode = code): CallContext =>
    testCallContext(marketOf(marketCode), 'system');

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
    onHand = 500,
    use: SetStockLevel = setStockLevel,
  ) {
    const known = catalogOffers.get(offerId);
    catalogOffers.set(offerId, {
      sellerId: seller.sellerId,
      deleted: false,
      productId: known?.productId ?? ids.next<'Product'>(),
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

  /** An Offer with stock on `count` Variants of its old product; nothing has moved yet. */
  async function stockedOffer(seller: Seller, count = 2, onHand = 500) {
    const offerId = ids.next<'Offer'>();
    const from = Array.from({ length: count }, () => ids.next<'Variant'>());
    for (const variantId of from) await stockOf(seller, offerId, variantId, onHand);
    const to = Array.from({ length: count }, () => ids.next<'Variant'>());
    return {
      offerId,
      from,
      to,
      fromProductId: catalogOffers.get(offerId)!.productId,
      toProductId: ids.next<'Product'>(),
    };
  }
  type Moved = Awaited<ReturnType<typeof stockedOffer>>;

  /** What catalog does when the Offer moves: its product and sell units change. */
  function move(seller: Seller, m: Moved) {
    catalogOffers.set(m.offerId, {
      sellerId: seller.sellerId,
      deleted: false,
      productId: m.toProductId,
      sellUnitVariantIds: new Set(m.to),
    });
  }
  const input = (m: Moved, over: Partial<RekeyMovedOfferInput> = {}): RekeyMovedOfferInput => ({
    delivery: delivery(),
    offerId: m.offerId,
    fromProductId: m.fromProductId,
    toProductId: m.toProductId,
    fromVariantIds: m.from,
    toVariantIds: m.to,
    sourceAggregateVersion: 5,
    ...over,
  });

  const rows = async (text: string, params: unknown[]) =>
    (await sql.query<Record<string, unknown>>(text, params)).rows;
  const itemsOf = (marketCode: string, offerId: string) =>
    rows(
      `SELECT id, variant_id, source_id, seller_id, on_hand, retired_at, version
         FROM inventory.stock_items WHERE market_id = $1 AND offer_id = $2 ORDER BY id`,
      [marketCode, offerId],
    );
  const movementsOf = (offerId: string, reason = 're-key') =>
    rows(
      `SELECT stock_item_id, variant_id, delta, resulting_on_hand, actor_kind, actor_module,
              actor_account_id, correlation_id
         FROM inventory.stock_movements WHERE market_id = $1 AND offer_id = $2 AND reason = $3
        ORDER BY id`,
      [code, offerId, reason],
    );
  const tombstonesOf = (variantId: string) =>
    rows(
      `SELECT scope, offer_id, variant_id, source_aggregate_version, tenant_id
         FROM inventory.retirements WHERE market_id = $1 AND variant_id = $2`,
      [code, variantId],
    );
  const statusOf = async (offerId: string, variantId: string) =>
    (
      await rows(
        `SELECT status FROM inventory.availability_signals
          WHERE market_id = $1 AND offer_id = $2 AND variant_id = $3`,
        [code, offerId, variantId],
      )
    )[0]?.status;
  const live = (items: Record<string, unknown>[]) => items.filter((r) => r.retired_at === null);

  it('moves the stock to the new Variants: items, ledger, tombstones and signals', async () => {
    const seller = await newSeller();
    const m = await stockedOffer(seller, 2, 500);
    move(seller, m);
    const context = system();

    const result = await rekey.execute(context, input(m));

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.rekeyed', sourceItems: 2, sellUnits: 4 },
    });
    const items = await itemsOf(code, m.offerId);
    expect(items).toHaveLength(4);
    expect(
      live(items)
        .map((r) => [r.variant_id, r.on_hand, r.seller_id])
        .sort(),
    ).toEqual(m.to.map((v) => [v, 500, seller.sellerId]).sort());
    expect(live(items).every((r) => r.source_id === seller.sourceId && r.version === 1)).toBe(true);
    const old = items.filter((r) => m.from.includes(r.variant_id as Id<'Variant'>));
    expect(old.every((r) => r.retired_at !== null && r.on_hand === 0 && r.version === 2)).toBe(
      true,
    );
    // The ledger: a pair of module-written re-key movements per source item, one correlation id.
    const movements = await movementsOf(m.offerId);
    expect(movements).toHaveLength(4);
    expect(
      movements.every(
        (r) =>
          r.actor_kind === 'module' &&
          r.actor_module === 'inventory' &&
          r.actor_account_id === null &&
          r.correlation_id === context.correlationId,
      ),
    ).toBe(true);
    expect(movements.map((r) => r.delta).sort()).toEqual([-500, -500, 500, 500]);
    expect(
      movements.filter((r) => (r.delta as number) < 0).map((r) => r.resulting_on_hand),
    ).toEqual([0, 0]);
    // The earlier seller writes keep their rows: history is never rewritten.
    expect(await movementsOf(m.offerId, 'seller-set')).toHaveLength(2);
    for (const variantId of m.from) {
      expect(await tombstonesOf(variantId)).toEqual([
        {
          scope: 'variant',
          offer_id: null,
          variant_id: variantId,
          source_aggregate_version: 5,
          tenant_id: marketOf(code).tenantId,
        },
      ]);
      expect(await statusOf(m.offerId, variantId)).toBe('out');
    }
    for (const variantId of m.to) expect(await statusOf(m.offerId, variantId)).toBe('in-stock');
  });

  it('refuses a seller write on an old Variant afterwards: the tombstone is the backstop', async () => {
    const seller = await newSeller();
    const m = await stockedOffer(seller, 1);
    move(seller, m);
    await rekey.execute(system(), input(m));
    // A write that passed the advisory ownership check before the move: catalog still lists it.
    catalogOffers.set(m.offerId, {
      ...catalogOffers.get(m.offerId)!,
      sellUnitVariantIds: new Set([...m.to, ...m.from]),
    });

    const late = await stockOf(seller, m.offerId, m.from[0]!, 9);

    expect(late).toEqual({ ok: false, error: { code: 'inventory.not-found' } });
    expect(live(await itemsOf(code, m.offerId)).map((r) => r.variant_id)).toEqual(m.to);
  });

  it('leaves an existing target row as it is and writes only the minus movement (Hassan M2)', async () => {
    const seller = await newSeller();
    const m = await stockedOffer(seller, 1, 40);
    move(seller, m);
    // The seller's write on the new key landed before the re-key: it is the intended total.
    expect((await stockOf(seller, m.offerId, m.to[0]!, 7)).ok).toBe(true);

    const result = await rekey.execute(system(), input(m));

    expect(result).toMatchObject({ ok: true, value: { code: 'inventory.rekeyed' } });
    const items = await itemsOf(code, m.offerId);
    expect(live(items).map((r) => [r.variant_id, r.on_hand, r.version])).toEqual([[m.to[0], 7, 1]]);
    expect((await movementsOf(m.offerId)).map((r) => [r.variant_id, r.delta])).toEqual([
      [m.from[0], -40],
    ]);
  });

  it('only retires what is left when the Offer tombstone came first', async () => {
    const seller = await newSeller();
    const m = await stockedOffer(seller, 1, 30);
    await retire.execute(system(), {
      delivery: { ...delivery(), subscriber: 'inventory.retire-on-offer-deleted' },
      target: { scope: 'offer', offerId: m.offerId },
      sourceAggregateVersion: 4,
    });
    // Events are unordered, so catalog's advisory answer can still show the Offer live.
    move(seller, m);

    const result = await rekey.execute(system(), input(m));

    expect(result).toMatchObject({
      ok: true,
      value: { code: 'inventory.rekeyed', sourceItems: 0 },
    });
    const items = await itemsOf(code, m.offerId);
    expect(items).toHaveLength(1);
    expect(items[0]!.variant_id).toBe(m.from[0]);
    expect(await movementsOf(m.offerId)).toEqual([]);
    expect(await tombstonesOf(m.from[0]!)).toEqual([]);
  });

  it('retires the source of a pair whose new Variant has a tombstone, without moving', async () => {
    const seller = await newSeller();
    const m = await stockedOffer(seller, 2, 60);
    move(seller, m);
    await retire.execute(system(), {
      delivery: { ...delivery(), subscriber: 'inventory.retire-on-variant-removed' },
      target: { scope: 'variant', variantId: m.to[0]! },
      sourceAggregateVersion: 2,
    });

    await rekey.execute(system(), input(m));

    const items = await itemsOf(code, m.offerId);
    expect(items.filter((r) => r.variant_id === m.to[0])).toEqual([]);
    expect(live(items).map((r) => [r.variant_id, r.on_hand])).toEqual([[m.to[1], 60]]);
    expect(
      items.filter((r) => r.variant_id === m.from[0]).every((r) => r.retired_at !== null),
    ).toBe(true);
    expect(await movementsOf(m.offerId)).toHaveLength(2);
  });

  it('replays as a no-op, and a second event for the Offer moves nothing', async () => {
    const seller = await newSeller();
    const m = await stockedOffer(seller, 1);
    move(seller, m);
    const first = input(m);
    await rekey.execute(system(), first);
    const itemsBefore = await itemsOf(code, m.offerId);
    const movementsBefore = await movementsOf(m.offerId);

    const again = await rekey.execute(system(), input(m, { sourceAggregateVersion: 6 }));

    expect(again).toMatchObject({ ok: true, value: { code: 'inventory.rekeyed', sourceItems: 0 } });
    expect(await itemsOf(code, m.offerId)).toEqual(itemsBefore);
    expect(await movementsOf(m.offerId)).toEqual(movementsBefore);
    // The tombstone keeps the version of the first event.
    expect((await tombstonesOf(m.from[0]!))[0]!.source_aggregate_version).toBe(5);
  });

  it('changes nothing when catalog does not confirm the move', async () => {
    const seller = await newSeller();
    const m = await stockedOffer(seller, 1);
    move(seller, m);
    catalogOffers.set(m.offerId, {
      ...catalogOffers.get(m.offerId)!,
      productId: ids.next<'Product'>(),
    });

    const result = await rekey.execute(system(), input(m));

    expect(result).toEqual({ ok: false, error: { code: 'inventory.rekey.offer-mismatch' } });
    expect(live(await itemsOf(code, m.offerId)).map((r) => r.variant_id)).toEqual(m.from);
    expect(await movementsOf(m.offerId)).toEqual([]);
    expect(await tombstonesOf(m.from[0]!)).toEqual([]);
  });

  it('leaves another Market untouched, even with the same ids', async () => {
    const mine = await newSeller();
    const theirs = await newSeller(other);
    const m = await stockedOffer(mine, 1);
    await runSerializable(db.unitOfWork, marketOf(other), async () =>
      ok(
        await stock.insertItem(marketOf(other), {
          id: ids.next<'StockItem'>(),
          offerId: m.offerId,
          variantId: m.from[0]!,
          sourceId: theirs.sourceId,
          sellerId: theirs.sellerId,
          onHand: 9,
          createdAt: T0,
        }),
      ),
    );
    move(mine, m);

    await rekey.execute(system(), input(m));

    const foreign = await itemsOf(other, m.offerId);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toMatchObject({ on_hand: 9, retired_at: null });
    expect(
      await rows(`SELECT 1 FROM inventory.retirements WHERE market_id = $1 AND variant_id = $2`, [
        other,
        m.from[0],
      ]),
    ).toEqual([]);
  });

  it('settles a seller write on the new key racing the re-key: one active target, never a sum', async () => {
    const seller = await newSeller();
    const m = await stockedOffer(seller, 1, 40);
    move(seller, m);
    // Both units read before either writes: the setter sees no target item yet and the re-key
    // would create it, so each alone is legal; SERIALIZABLE refuses one with 40001.
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
      itemIdsOfOfferVariants: async (...args) => {
        const found = await stock.itemIdsOfOfferVariants(...args);
        reads += 1;
        await meet();
        return found;
      },
      activeItemIds: (...args) => stock.activeItemIds(...args),
      isSellUnitRetired: (...args) => stock.isSellUnitRetired(...args),
      heldQuantities: (...args) => stock.heldQuantities(...args),
      insertItem: (...args) => stock.insertItem(...args),
      setOnHand: (...args) => stock.setOnHand(...args),
      appendMovement: (...args) => stock.appendMovement(...args),
      lockItems: (...args) => stock.lockItems(...args),
      tombstonesOf: (...args) => stock.tombstonesOf(...args),
      recordTombstone: (...args) => stock.recordTombstone(...args),
      retireItems: (...args) => stock.retireItems(...args),
    };
    const racing = build(wrapped);

    const [written, moved] = await Promise.all([
      racing.set.execute(seller.context, {
        offerId: m.offerId,
        variantId: m.to[0]!,
        sourceId: seller.sourceId,
        onHand: 7,
        expectedVersion: null,
      }),
      racing.rekey.execute(system(), input(m)),
    ]);

    expect(moved.ok).toBe(true);
    // Both read the empty target; one write was refused with 40001 and its unit ran again.
    expect(reads).toBeGreaterThan(2);
    const active = live(await itemsOf(code, m.offerId));
    expect(active.map((r) => r.variant_id)).toEqual([m.to[0]]);
    const movements = await movementsOf(m.offerId);
    if (written.ok) {
      // The seller's write is the intended total; the re-key added nothing to it.
      expect(active[0]!.on_hand).toBe(7);
      expect(movements.map((r) => r.delta)).toEqual([-40]);
    } else {
      // The re-key created the item first, so a first write (no version) is stale.
      expect(written.error.code).toBe('conflict.stale');
      expect(active[0]!.on_hand).toBe(40);
      expect(movements.map((r) => r.delta).sort()).toEqual([-40, 40]);
    }
  });
});
