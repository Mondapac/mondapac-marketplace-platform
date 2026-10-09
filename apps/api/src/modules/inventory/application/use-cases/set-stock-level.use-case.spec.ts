import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  testMarketId,
} from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerInventory } from '../../domain/seller-inventory';
import type { StoredSignal } from '../../domain/stock';
import { ConfigInventoryPolicyProvider } from '../../infrastructure/config-inventory-policy-provider';
import type {
  AvailabilitySignalRepository,
  NewAvailabilitySignal,
} from '../ports/availability-signal.repository';
import type { OfferSellUnitsSource, StockOfferView } from '../ports/offer-sell-units';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import type {
  NewStockItem,
  NewStockMovement,
  StockItemRow,
  StockRepository,
} from '../ports/stock.repository';
import { SetStockLevel, type SetStockLevelInput } from './set-stock-level.use-case';

// Inventory slice 2, part 3 in memory (inventory design 4.5, 5.2, 5.3; AC 7, 9, 11) on both Market
// fixtures: the default low-stock threshold differs between them (AU 10, ZZ 3). The gate admits
// every authenticated actor; the declaration is checked by the CI list. PostgreSQL behaviour (the
// lock, the serializable creation race, the constraints) is in test/db/inventory-stock.db-spec.ts.

const START = Temporal.Instant.from('2026-10-09T01:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigInventoryPolicyProvider(markets);

class FakeInventories implements SellerInventoryRepository {
  readonly stored = new Map<string, SellerInventory>();
  add(market: MarketContext, inventory: SellerInventory): Promise<boolean> {
    this.stored.set(`${market.marketId}|${inventory.state.sellerId}`, inventory);
    return Promise.resolve(true);
  }
  findBySeller(market: MarketContext, sellerId: Id<'Seller'>) {
    const found = this.stored.get(`${market.marketId}|${sellerId}`);
    return Promise.resolve(found === undefined ? null : SellerInventory.fromStored(found.state));
  }
  save(): Promise<'saved' | 'stale'> {
    return Promise.reject(new Error('not used'));
  }
}

class FakeStock implements StockRepository {
  items: StockItemRow[] = [];
  readonly movements: NewStockMovement[] = [];
  readonly retired = new Set<string>();
  readonly held = new Map<string, number>();
  locks = 0;
  /** Set to make the next `setOnHand` find another write in between. */
  staleOnSet = false;

  lockSellUnit(_m: MarketContext, offerId: Id<'Offer'>, variantId: Id<'Variant'>) {
    this.locks += 1;
    return Promise.resolve(
      this.items.filter((i) => i.offerId === offerId && i.variantId === variantId),
    );
  }
  isSellUnitRetired(_m: MarketContext, offerId: Id<'Offer'>) {
    return Promise.resolve(this.retired.has(offerId));
  }
  heldQuantities(_m: MarketContext, ids: readonly Id<'StockItem'>[]) {
    return Promise.resolve(new Map(ids.map((id) => [id, this.held.get(id) ?? 0] as const)));
  }
  insertItem(_m: MarketContext, item: NewStockItem) {
    this.items.push({ ...item, retired: false, version: 1 });
    return Promise.resolve();
  }
  setOnHand(_m: MarketContext, id: Id<'StockItem'>, expected: number, onHand: number) {
    const index = this.items.findIndex((i) => i.id === id);
    const current = this.items[index];
    if (this.staleOnSet || current === undefined || current.version !== expected) {
      this.staleOnSet = false;
      return Promise.resolve('stale' as const);
    }
    this.items[index] = { ...current, onHand, version: expected + 1 };
    return Promise.resolve('saved' as const);
  }
  appendMovement(_m: MarketContext, movement: NewStockMovement) {
    this.movements.push(movement);
    return Promise.resolve();
  }
}

class FakeSignals implements AvailabilitySignalRepository {
  readonly rows = new Map<string, NewAvailabilitySignal>();
  find(_m: MarketContext, offerId: Id<'Offer'>, variantId: Id<'Variant'>) {
    const row = this.rows.get(`${offerId}|${variantId}`);
    const stored: StoredSignal | null =
      row === undefined
        ? null
        : { id: row.id, status: row.status, onlyLeft: row.onlyLeft, version: row.version };
    return Promise.resolve(stored);
  }
  insert(_m: MarketContext, signal: NewAvailabilitySignal) {
    this.rows.set(`${signal.offerId}|${signal.variantId}`, signal);
    return Promise.resolve();
  }
  update(
    _m: MarketContext,
    id: Id<'AvailabilitySignal'>,
    expected: number,
    change: Pick<NewAvailabilitySignal, 'status' | 'onlyLeft' | 'changedAt' | 'version'>,
  ) {
    for (const [key, row] of this.rows) {
      if (row.id === id && row.version === expected) {
        this.rows.set(key, { ...row, ...change });
        return Promise.resolve('saved' as const);
      }
    }
    return Promise.resolve('stale' as const);
  }
}

class FakeOffers implements OfferSellUnitsSource {
  readonly offers = new Map<Id<'Offer'>, StockOfferView>();
  calls = 0;
  fail = false;
  sellUnitsOf(_c: CallContext, offerIds: readonly Id<'Offer'>[]) {
    this.calls += 1;
    if (this.fail) return Promise.reject(new Error('catalog unavailable'));
    const answer = new Map<Id<'Offer'>, StockOfferView>();
    for (const id of offerIds) {
      const offer = this.offers.get(id);
      if (offer !== undefined) answer.set(id, offer);
    }
    return Promise.resolve(answer);
  }
}

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const inventories = new FakeInventories();
  const stock = new FakeStock();
  const signals = new FakeSignals();
  const offers = new FakeOffers();
  const events: PendingEvent[] = [];
  const outbox: OutboxWriter = {
    append: (_c, appended) => {
      events.push(...appended);
      return Promise.resolve();
    },
  };
  const units: UnitOfWorkOptions[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      o: UnitOfWorkOptions = {},
    ) => {
      units.push(o);
      return work();
    },
    runOnce: () => Promise.reject(new Error('not used')),
  };
  const setStockLevel = new SetStockLevel(gate, {
    unitOfWork,
    inventories,
    stock,
    signals,
    offers,
    policies,
    outbox,
    ids,
    clock,
  });
  return { clock, ids, inventories, stock, signals, offers, events, units, setStockLevel };
}
type T = ReturnType<typeof setUp>;

describe.each(['AU', 'ZZ'] as const)('inventory.set-stock-level in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const defaultThreshold = markets.get(testMarketId(code)).inventory!.defaultLowStockThreshold;
  const logged: unknown[] = [];
  beforeEach(() => {
    logged.length = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logged.push(m);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  /** A ready seller with one Offer (one Variant) and a second source. */
  function world(t: T, over: { threshold?: number | null } = {}) {
    const sellerId = t.ids.next<'Seller'>();
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId,
      }),
    );
    const base = SellerInventory.createWithDefaultSource({
      id: t.ids.next<'SellerInventory'>(),
      defaultSourceId: t.ids.next<'InventorySource'>(),
      sellerId,
      marketId: market.marketId,
      now: START,
    });
    const inventory = SellerInventory.fromStored({
      ...base.state,
      lowStockThreshold: over.threshold ?? null,
    });
    void t.inventories.add(market, inventory);
    const offerId = t.ids.next<'Offer'>();
    const variantId = t.ids.next<'Variant'>();
    t.offers.offers.set(offerId, {
      sellerId,
      deleted: false,
      sellUnitVariantIds: new Set([variantId]),
    });
    const sourceId = inventory.state.sources[0]!.id;
    const input = (over2: Partial<SetStockLevelInput> = {}): SetStockLevelInput => ({
      offerId,
      variantId,
      sourceId,
      onHand: 20,
      expectedVersion: null,
      ...over2,
    });
    return { sellerId, context, offerId, variantId, sourceId, input };
  }
  const value = <V>(result: { ok: true; value: V } | { ok: false; error: unknown }): V => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };
  const code_ = (result: { ok: boolean; error?: { code: string } }) =>
    result.ok ? 'ok' : result.error?.code;

  it('declares inventory.stock.edit, denied for an unapproved seller', () => {
    expect(SetStockLevel.access).toMatchObject({
      name: 'inventory.set-stock-level',
      rule: { kind: 'permissions', allOf: ['inventory.stock.edit'] },
      whenSellerNotApproved: 'deny',
    });
  });

  it('creates the item at version 1, writes one movement, a signal and one event', async () => {
    const t = setUp();
    const w = world(t);

    const out = value(await t.setStockLevel.execute(w.context, w.input({ onHand: 20 })));

    expect(out).toMatchObject({ onHand: 20, version: 1, changed: true });
    expect(t.stock.items).toEqual([
      expect.objectContaining({
        sellerId: w.sellerId,
        sourceId: w.sourceId,
        onHand: 20,
        version: 1,
      }),
    ]);
    expect(t.stock.movements).toEqual([
      expect.objectContaining({
        delta: 20,
        resultingOnHand: 20,
        reason: 'seller-set',
        correlationId: w.context.correlationId,
      }),
    ]);
    expect([...t.signals.rows.values()]).toEqual([
      expect.objectContaining({ status: 'in-stock', onlyLeft: null, version: 1 }),
    ]);
    expect(t.events.map((e) => e.type)).toEqual(['inventory.availability-changed.v1']);
  });

  it('opens one serializable unit and asks catalog before it, once', async () => {
    const t = setUp();
    const w = world(t);

    await t.setStockLevel.execute(w.context, w.input());

    expect(t.units).toEqual([{ isolation: 'serializable' }]);
    expect(t.offers.calls).toBe(1);
    expect(t.stock.locks).toBe(1);
  });

  it('uses the Market default threshold: onHand = default is low, one above is in stock', async () => {
    const t = setUp();
    const w = world(t);

    await t.setStockLevel.execute(w.context, w.input({ onHand: defaultThreshold }));
    const low = [...t.signals.rows.values()][0];
    expect(low).toMatchObject({ status: 'low', onlyLeft: defaultThreshold });

    const again = await t.setStockLevel.execute(
      w.context,
      w.input({ onHand: defaultThreshold + 1, expectedVersion: 1 }),
    );
    expect(code_(again)).toBe('ok');
    expect([...t.signals.rows.values()][0]).toMatchObject({ status: 'in-stock', onlyLeft: null });
  });

  it("uses the seller's own threshold over the Market default (AC 7: threshold 5)", async () => {
    const t = setUp();
    const w = world(t, { threshold: 5 });

    await t.setStockLevel.execute(w.context, w.input({ onHand: 4 }));

    expect([...t.signals.rows.values()][0]).toMatchObject({ status: 'low', onlyLeft: 4 });
  });

  it('announces the first entry into low once, with the next version', async () => {
    const t = setUp();
    const w = world(t, { threshold: 5 });
    await t.setStockLevel.execute(w.context, w.input({ onHand: 50 }));
    t.events.length = 0;

    await t.setStockLevel.execute(w.context, w.input({ onHand: 4, expectedVersion: 1 }));

    expect(t.events.map((e) => [e.type, e.aggregateVersion])).toEqual([
      ['inventory.availability-changed.v1', 2],
      ['inventory.low-stock-reached.v1', 3],
    ]);
    expect([...t.signals.rows.values()][0]).toMatchObject({ version: 3, status: 'low' });
    expect(t.events[1]?.payload).toMatchObject({ sellerId: w.sellerId, onlyLeft: 4 });
  });

  it('writes the delta of a change and raises the version by one', async () => {
    const t = setUp();
    const w = world(t);
    await t.setStockLevel.execute(w.context, w.input({ onHand: 20 }));

    const out = value(
      await t.setStockLevel.execute(w.context, w.input({ onHand: 12, expectedVersion: 1 })),
    );

    expect(out).toMatchObject({ onHand: 12, version: 2, changed: true });
    expect(t.stock.movements.map((m) => [m.delta, m.resultingOnHand])).toEqual([
      [20, 20],
      [-8, 12],
    ]);
  });

  it('treats the stored level as no change: no movement, no version, no event (M4)', async () => {
    const t = setUp();
    const w = world(t);
    await t.setStockLevel.execute(w.context, w.input({ onHand: 20 }));
    t.events.length = 0;

    const out = value(
      await t.setStockLevel.execute(w.context, w.input({ onHand: 20, expectedVersion: 1 })),
    );

    expect(out).toMatchObject({ onHand: 20, version: 1, changed: false });
    expect(t.stock.movements).toHaveLength(1);
    expect(t.events).toEqual([]);
  });

  it('creates an item at 0 with no movement (the delta CHECK refuses 0) and an out signal', async () => {
    const t = setUp();
    const w = world(t);

    await t.setStockLevel.execute(w.context, w.input({ onHand: 0 }));

    expect(t.stock.items).toHaveLength(1);
    expect(t.stock.movements).toEqual([]);
    expect([...t.signals.rows.values()][0]).toMatchObject({ status: 'out' });
  });

  it('answers conflict.stale for a wrong or missing expected version', async () => {
    const t = setUp();
    const w = world(t);
    await t.setStockLevel.execute(w.context, w.input({ onHand: 20 }));

    const wrong = await t.setStockLevel.execute(w.context, w.input({ expectedVersion: 7 }));
    const missing = await t.setStockLevel.execute(w.context, w.input({ expectedVersion: null }));
    t.stock.staleOnSet = true;
    const raced = await t.setStockLevel.execute(
      w.context,
      w.input({ onHand: 21, expectedVersion: 1 }),
    );

    expect([code_(wrong), code_(missing), code_(raced)]).toEqual([
      'conflict.stale',
      'conflict.stale',
      'conflict.stale',
    ]);
    expect(t.stock.items[0]).toMatchObject({ onHand: 20, version: 1 });
  });

  it('answers conflict.stale for a version on a source with no item yet', async () => {
    const t = setUp();
    const w = world(t);

    const result = await t.setStockLevel.execute(w.context, w.input({ expectedVersion: 1 }));

    expect(code_(result)).toBe('conflict.stale');
    expect(t.stock.items).toEqual([]);
  });

  it('refuses a level below what is held, with the minimum (AC 9)', async () => {
    const t = setUp();
    const w = world(t);
    await t.setStockLevel.execute(w.context, w.input({ onHand: 20 }));
    t.stock.held.set(t.stock.items[0]!.id, 6);

    const below = await t.setStockLevel.execute(
      w.context,
      w.input({ onHand: 5, expectedVersion: 1 }),
    );
    const exact = await t.setStockLevel.execute(
      w.context,
      w.input({ onHand: 6, expectedVersion: 1 }),
    );

    expect(below).toEqual({
      ok: false,
      error: { code: 'inventory.stock.below-held', details: { min: 6 } },
    });
    expect(code_(exact)).toBe('ok');
  });

  it('counts the sell unit as the largest source, not the sum', async () => {
    const t = setUp();
    const w = world(t, { threshold: 5 });
    const second = t.ids.next<'InventorySource'>();
    t.stock.items.push({
      id: t.ids.next<'StockItem'>(),
      offerId: w.offerId,
      variantId: w.variantId,
      sourceId: second,
      sellerId: w.sellerId,
      onHand: 3,
      retired: false,
      version: 1,
    });

    await t.setStockLevel.execute(w.context, w.input({ onHand: 4 }));

    expect([...t.signals.rows.values()][0]).toMatchObject({ status: 'low', onlyLeft: 4 });
  });

  it('answers stale for a same-level write with an old version, before the no-change shortcut', async () => {
    const t = setUp();
    const w = world(t);
    await t.setStockLevel.execute(w.context, w.input({ onHand: 20 }));

    const result = await t.setStockLevel.execute(
      w.context,
      w.input({ onHand: 20, expectedVersion: 4 }),
    );

    expect(code_(result)).toBe('conflict.stale');
  });

  it('takes the seller threshold of 0: in stock at 1, never low', async () => {
    const t = setUp();
    const w = world(t, { threshold: 0 });

    await t.setStockLevel.execute(w.context, w.input({ onHand: 1 }));

    expect([...t.signals.rows.values()][0]).toMatchObject({ status: 'in-stock', onlyLeft: null });
  });

  it('writes the largest level and back to 0 (the ledger delta of the extremes)', async () => {
    const t = setUp();
    const w = world(t);

    await t.setStockLevel.execute(w.context, w.input({ onHand: 2_147_483_647 }));
    await t.setStockLevel.execute(w.context, w.input({ onHand: 0, expectedVersion: 1 }));

    expect(t.stock.movements.map((m) => m.delta)).toEqual([2_147_483_647, -2_147_483_647]);
    expect([...t.signals.rows.values()][0]).toMatchObject({ status: 'out' });
  });

  it('counts the largest sellable, not the largest on hand, and skips a retired source', async () => {
    const t = setUp();
    const w = world(t, { threshold: 5 });
    const big = t.ids.next<'StockItem'>();
    const retired = t.ids.next<'StockItem'>();
    t.stock.items.push(
      {
        id: big,
        offerId: w.offerId,
        variantId: w.variantId,
        sourceId: t.ids.next<'InventorySource'>(),
        sellerId: w.sellerId,
        onHand: 100,
        retired: false,
        version: 1,
      },
      {
        id: retired,
        offerId: w.offerId,
        variantId: w.variantId,
        sourceId: t.ids.next<'InventorySource'>(),
        sellerId: w.sellerId,
        onHand: 500,
        retired: true,
        version: 1,
      },
    );
    t.stock.held.set(big, 98);

    await t.setStockLevel.execute(w.context, w.input({ onHand: 3 }));

    // sellable: big 100 - 98 = 2, own 3, retired ignored: the largest is 3.
    expect([...t.signals.rows.values()][0]).toMatchObject({ status: 'low', onlyLeft: 3 });
  });

  it('asks the lock before the tombstone and the item reads', async () => {
    const t = setUp();
    const w = world(t);
    const order: string[] = [];
    const lock = t.stock.lockSellUnit.bind(t.stock);
    const retired = t.stock.isSellUnitRetired.bind(t.stock);
    t.stock.lockSellUnit = (...args) => {
      order.push('lock');
      return lock(...args);
    };
    t.stock.isSellUnitRetired = (...args) => {
      order.push('tombstone');
      return retired(...args);
    };

    await t.setStockLevel.execute(w.context, w.input());

    expect(order).toEqual(['lock', 'tombstone']);
  });

  describe('answers inventory.not-found, the same for every cause (AC 11)', () => {
    it.each([
      [
        'an unknown Offer',
        (t: T, w: ReturnType<typeof world>) => t.offers.offers.delete(w.offerId),
      ],
      [
        "another seller's Offer",
        (t: T, w: ReturnType<typeof world>) =>
          t.offers.offers.set(w.offerId, {
            sellerId: t.ids.next<'Seller'>(),
            deleted: false,
            sellUnitVariantIds: new Set([w.variantId]),
          }),
      ],
      [
        'a deleted Offer',
        (t: T, w: ReturnType<typeof world>) =>
          t.offers.offers.set(w.offerId, {
            sellerId: w.sellerId,
            deleted: true,
            sellUnitVariantIds: new Set(),
          }),
      ],
      [
        'a Variant that is not a sell unit',
        (t: T, w: ReturnType<typeof world>) =>
          t.offers.offers.set(w.offerId, {
            sellerId: w.sellerId,
            deleted: false,
            sellUnitVariantIds: new Set([t.ids.next<'Variant'>()]),
          }),
      ],
      [
        'a retirement tombstone',
        (t: T, w: ReturnType<typeof world>) => t.stock.retired.add(w.offerId),
      ],
      [
        'a retired item on the source',
        (t: T, w: ReturnType<typeof world>) =>
          t.stock.items.push({
            id: t.ids.next<'StockItem'>(),
            offerId: w.offerId,
            variantId: w.variantId,
            sourceId: w.sourceId,
            sellerId: w.sellerId,
            onHand: 3,
            retired: true,
            version: 2,
          }),
      ],
      [
        'an item of another seller on the sell unit',
        (t: T, w: ReturnType<typeof world>) =>
          t.stock.items.push({
            id: t.ids.next<'StockItem'>(),
            offerId: w.offerId,
            variantId: w.variantId,
            sourceId: t.ids.next<'InventorySource'>(),
            sellerId: t.ids.next<'Seller'>(),
            onHand: 3,
            retired: false,
            version: 1,
          }),
      ],
    ])('for %s', async (_name, arrange) => {
      const t = setUp();
      const w = world(t);
      arrange(t, w);

      const result = await t.setStockLevel.execute(w.context, w.input({ expectedVersion: null }));

      expect(result).toEqual({ ok: false, error: { code: 'inventory.not-found' } });
      expect(t.stock.movements).toEqual([]);
      expect(t.events).toEqual([]);
      expect(t.signals.rows.size).toBe(0);
    });

    it("for a source that is not the seller's", async () => {
      const t = setUp();
      const w = world(t);

      const result = await t.setStockLevel.execute(
        w.context,
        w.input({ sourceId: t.ids.next<'InventorySource'>() }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'inventory.not-found' } });
      expect(t.stock.items).toEqual([]);
    });
  });

  it("answers inventory.not-found when another Market's seller id is the actor's own", async () => {
    // The catalog view for the Offer is absent in this Market (another Market's id): same answer.
    const t = setUp();
    const w = world(t);
    t.offers.offers.clear();

    const result = await t.setStockLevel.execute(w.context, w.input());

    expect(code_(result)).toBe('inventory.not-found');
  });

  it('answers inventory.not-ready for a seller with no inventory yet', async () => {
    const t = setUp();
    const w = world(t);
    t.inventories.stored.clear();

    expect(code_(await t.setStockLevel.execute(w.context, w.input()))).toBe('inventory.not-ready');
  });

  it('lets a catalog failure out: it is never read as absent or as permission', async () => {
    const t = setUp();
    const w = world(t);
    t.offers.fail = true;

    await expect(t.setStockLevel.execute(w.context, w.input())).rejects.toThrow(
      'catalog unavailable',
    );
    expect(t.stock.items).toEqual([]);
  });

  it('refuses an actor that is not a seller before any read', async () => {
    const t = setUp();
    const w = world(t);
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId: null,
      }),
    );

    const result = await t.setStockLevel.execute(customer, w.input());

    expect(code_(result)).toBe('access.denied');
    expect(t.offers.calls).toBe(0);
  });

  it.each([
    ['a non-uuid Offer', { offerId: 'nope' }, 'offerId', 'format'],
    ['a non-uuid Variant', { variantId: '' }, 'variantId', 'format'],
    ['a non-uuid source', { sourceId: 5 as unknown as string }, 'sourceId', 'format'],
    ['a negative level', { onHand: -1 }, 'onHand', 'range'],
    ['a fractional level', { onHand: 1.5 }, 'onHand', 'range'],
    ['a text level', { onHand: '5' as unknown as number }, 'onHand', 'range'],
    ['a zero version', { expectedVersion: 0 }, 'expectedVersion', 'format'],
  ])('rejects %s with the path and rule only', async (_name, over, path, rule) => {
    const t = setUp();
    const w = world(t);

    const result = await t.setStockLevel.execute(w.context, w.input(over));

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: rule }] },
    });
    expect(t.offers.calls).toBe(0);
  });

  it('logs ids of the request and codes, never a level or a seller value', async () => {
    const t = setUp();
    const w = world(t);
    await t.setStockLevel.execute(w.context, w.input({ onHand: 777 }));
    await t.setStockLevel.execute(w.context, w.input({ onHand: 778 }));

    const text = JSON.stringify(logged);
    expect(text).toContain('inventory.set-stock-level.done');
    expect(text).toContain('inventory.set-stock-level.refused');
    expect(text).not.toContain('777');
    expect(text).not.toContain(w.sellerId);
  });
});
