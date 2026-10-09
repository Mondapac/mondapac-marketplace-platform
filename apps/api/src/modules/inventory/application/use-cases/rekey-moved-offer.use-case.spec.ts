import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import {
  MAX_UNIT_TIMEOUT_MS,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigInventoryPolicyProvider } from '../../infrastructure/config-inventory-policy-provider';
import type { StoredSignal } from '../../domain/stock';
import type {
  AvailabilitySignalRepository,
  NewAvailabilitySignal,
} from '../ports/availability-signal.repository';
import type { OfferSellUnitsSource, StockOfferView } from '../ports/offer-sell-units';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import type {
  NewRetirementTombstone,
  NewStockItem,
  NewStockMovement,
  OfferTombstones,
  StockItemRow,
  StockRepository,
} from '../ports/stock.repository';
import { RekeyMovedOffer, type RekeyMovedOfferInput } from './rekey-moved-offer.use-case';

// Inventory slice 2, part 5 in memory (inventory design 3.6): the re-key handler on both Market
// fixtures. PostgreSQL behaviour (locks, constraints, the race) is covered by
// test/db/inventory-rekey-moved-offer.db-spec.ts.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const policies = new ConfigInventoryPolicyProvider(markets);

class FakeStock implements StockRepository {
  items: StockItemRow[] = [];
  readonly movements: NewStockMovement[] = [];
  readonly tombstones: NewRetirementTombstone[] = [];
  readonly calls: string[] = [];
  readonly held = new Map<string, number>();
  offerRetired = false;
  retiredVariants = new Set<Id<'Variant'>>();

  itemIdsOfOfferVariants(
    _m: MarketContext,
    offerId: Id<'Offer'>,
    variantIds: readonly Id<'Variant'>[],
  ) {
    this.calls.push('read');
    return Promise.resolve(
      this.items
        .filter((i) => i.offerId === offerId && variantIds.includes(i.variantId))
        .map((i) => i.id)
        .sort(),
    );
  }
  lockItems(_m: MarketContext, ids: readonly Id<'StockItem'>[]) {
    this.calls.push('lock');
    return Promise.resolve(this.items.filter((i) => ids.includes(i.id)));
  }
  tombstonesOf(): Promise<OfferTombstones> {
    this.calls.push('tombstones');
    return Promise.resolve({
      offerRetired: this.offerRetired,
      retiredVariantIds: this.retiredVariants,
    });
  }
  heldQuantities(_m: MarketContext, ids: readonly Id<'StockItem'>[]) {
    return Promise.resolve(new Map(ids.map((id) => [id, this.held.get(id) ?? 0] as const)));
  }
  insertItem(_m: MarketContext, item: NewStockItem) {
    this.calls.push('insert');
    this.items.push({ ...item, retired: false, version: 1 });
    return Promise.resolve();
  }
  appendMovement(_m: MarketContext, movement: NewStockMovement) {
    this.movements.push(movement);
    return Promise.resolve();
  }
  recordTombstone(_m: MarketContext, tombstone: NewRetirementTombstone) {
    this.calls.push('tombstone');
    this.tombstones.push(tombstone);
    return Promise.resolve();
  }
  retireItems(_m: MarketContext, ids: readonly Id<'StockItem'>[]) {
    this.calls.push('retire');
    let changed = 0;
    this.items = this.items.map((i) => {
      if (!ids.includes(i.id) || i.retired) return i;
      changed += 1;
      return { ...i, retired: true };
    });
    return Promise.resolve(changed);
  }
  lockSellUnit() {
    return Promise.reject(new Error('not used'));
  }
  isSellUnitRetired() {
    return Promise.reject(new Error('not used'));
  }
  activeItemIds() {
    return Promise.reject(new Error('not used'));
  }
  setOnHand() {
    return Promise.reject(new Error('not used'));
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
  readonly offers = new Map<string, StockOfferView>();
  calls = 0;
  unavailable = false;
  sellUnitsOf(_c: unknown, offerIds: readonly Id<'Offer'>[]) {
    this.calls += 1;
    if (this.unavailable) return Promise.reject(new Error('catalog down'));
    const answer = new Map<Id<'Offer'>, StockOfferView>();
    for (const id of offerIds) {
      const offer = this.offers.get(id);
      if (offer !== undefined) answer.set(id, offer);
    }
    return Promise.resolve(answer);
  }
}

const noInventories: SellerInventoryRepository = {
  add: () => Promise.reject(new Error('not used')),
  findBySeller: () => Promise.resolve(null),
  save: () => Promise.reject(new Error('not used')),
};

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
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
  const options: (UnitOfWorkOptions | undefined)[] = [];
  const once = fakeRunOnce();
  const unitOfWork: UnitOfWork = {
    run: () => Promise.reject(new Error('not used')),
    runOnce: (market, delivery, work, opts) => {
      options.push(opts);
      return once(market, delivery, work);
    },
  };
  const rekey = new RekeyMovedOffer(gate, {
    unitOfWork,
    inventories: noInventories,
    stock,
    signals,
    offers,
    policies,
    outbox,
    ids,
    clock,
  });
  return { ids, stock, signals, offers, events, options, rekey };
}

type Setup = ReturnType<typeof setUp>;
const market = (code: string): MarketContext => testMarketContext(code, 'default');
const system = (code: string) => testCallContext(market(code), 'system');

/** An Offer of one seller that moved from one product to another, with `pairs` mapped Variants. */
function world(t: Setup, pairs = 2) {
  const sellerId = t.ids.next<'Seller'>();
  const offerId = t.ids.next<'Offer'>();
  const fromProductId = t.ids.next<'Product'>();
  const toProductId = t.ids.next<'Product'>();
  const from = Array.from({ length: pairs }, () => t.ids.next<'Variant'>());
  const to = Array.from({ length: pairs }, () => t.ids.next<'Variant'>());
  t.offers.offers.set(offerId, {
    sellerId,
    productId: toProductId,
    deleted: false,
    sellUnitVariantIds: new Set(to),
  });
  const input = (over: Partial<RekeyMovedOfferInput> = {}): RekeyMovedOfferInput => ({
    delivery: delivery(t),
    offerId,
    fromProductId,
    toProductId,
    fromVariantIds: from,
    toVariantIds: to,
    sourceAggregateVersion: 4,
    ...over,
  });
  return { sellerId, offerId, fromProductId, toProductId, from, to, input };
}

const delivery = (t: Setup): EventDelivery => ({
  eventId: t.ids.next<'event'>(),
  subscriber: 'inventory.rekey-on-offer-moved',
  attempt: 1,
});

function stockItem(
  t: Setup,
  w: ReturnType<typeof world>,
  variantId: Id<'Variant'>,
  onHand: number,
  sourceId = t.ids.next<'InventorySource'>(),
  retired = false,
): StockItemRow {
  const row: StockItemRow = {
    id: t.ids.next<'StockItem'>(),
    offerId: w.offerId,
    variantId,
    sourceId,
    sellerId: w.sellerId,
    onHand,
    retired,
    version: 1,
  };
  t.stock.items.push(row);
  return row;
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
beforeEach(() => {
  warn.mockClear();
  error.mockClear();
});
afterAll(() => jest.restoreAllMocks());

const logged = (spy: jest.SpyInstance, msg: string): unknown[][] =>
  (spy.mock.calls as unknown[][]).filter(([entry]) => (entry as { msg?: string }).msg === msg);

describe.each(['AU', 'ZZ'])('inventory.rekey-moved-offer in market %s', (code) => {
  it('moves the stock to the new Variants, retires the old items and tombstones the old Variants', async () => {
    const t = setUp();
    const w = world(t, 2);
    const [s1, s2] = [t.ids.next<'InventorySource'>(), t.ids.next<'InventorySource'>()];
    const a1 = stockItem(t, w, w.from[0]!, 500, s1);
    const a2 = stockItem(t, w, w.from[0]!, 300, s2);
    const b1 = stockItem(t, w, w.from[1]!, 200, s1);

    const result = await t.rekey.execute(system(code), w.input());

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.rekeyed', sourceItems: 3, sellUnits: 4 },
    });
    const live = t.stock.items.filter((i) => !i.retired);
    expect(
      live
        .map((i) => [i.variantId, i.sourceId, i.onHand, i.sellerId])
        .sort((x, y) => (String(x[0]) + String(x[1]) < String(y[0]) + String(y[1]) ? -1 : 1)),
    ).toEqual(
      [
        [w.to[0], s1, 500, w.sellerId],
        [w.to[0], s2, 300, w.sellerId],
        [w.to[1], s1, 200, w.sellerId],
      ].sort((x, y) => (String(x[0]) + String(x[1]) < String(y[0]) + String(y[1]) ? -1 : 1)),
    );
    expect([a1, a2, b1].every((i) => t.stock.items.find((x) => x.id === i.id)!.retired)).toBe(true);
    // Two re-key movements per moved source item, with the event's correlation id.
    expect(t.stock.movements).toHaveLength(6);
    expect(t.stock.movements.every((m) => m.reason === 're-key')).toBe(true);
    expect(t.stock.movements.map((m) => m.delta).sort((x, y) => x - y)).toEqual([
      -500, -300, -200, 200, 300, 500,
    ]);
    expect(t.stock.movements.filter((m) => m.delta < 0).map((m) => m.resultingOnHand)).toEqual([
      0, 0, 0,
    ]);
    // Variant tombstones for the old Variants, stamped with the event's version.
    expect(t.stock.tombstones.map((x) => x.target)).toEqual(
      w.from.map((variantId) => ({ scope: 'variant', variantId })),
    );
    expect(t.stock.tombstones.every((x) => x.sourceAggregateVersion === 4)).toBe(true);
    // Old sell units go out; new ones are in stock.
    const status = (variantId: Id<'Variant'>) =>
      t.signals.rows.get(`${w.offerId}|${variantId}`)?.status;
    expect(w.from.map(status)).toEqual(['out', 'out']);
    expect(w.to.map(status)).toEqual(['in-stock', 'in-stock']);
    // The order of the design: read, lock, tombstones, then writes.
    expect(t.stock.calls.slice(0, 3)).toEqual(['read', 'lock', 'tombstones']);
    expect(t.options).toEqual([{ isolation: 'serializable', timeoutMs: MAX_UNIT_TIMEOUT_MS }]);
  });

  it('moves only onHand minus pending and leaves the pending on the retired old item', async () => {
    const t = setUp();
    const w = world(t, 1);
    const old = stockItem(t, w, w.from[0]!, 500);
    t.stock.held.set(old.id, 120);

    await t.rekey.execute(system(code), w.input());

    const target = t.stock.items.find((i) => i.variantId === w.to[0])!;
    expect(target.onHand).toBe(380);
    expect(t.stock.movements.map((m) => [m.delta, m.resultingOnHand])).toEqual([
      [-380, 120],
      [380, 380],
    ]);
  });

  it('writes no movement and an empty target when the source has nothing to move', async () => {
    const t = setUp();
    const w = world(t, 1);
    stockItem(t, w, w.from[0]!, 0);

    await t.rekey.execute(system(code), w.input());

    expect(t.stock.items.find((i) => i.variantId === w.to[0])?.onHand).toBe(0);
    expect(t.stock.movements).toEqual([]);
  });

  it('clamps a negative moved quantity to zero and raises an alert', async () => {
    const t = setUp();
    const w = world(t, 1);
    const old = stockItem(t, w, w.from[0]!, 5);
    t.stock.held.set(old.id, 9);

    await t.rekey.execute(system(code), w.input());

    expect(t.stock.items.find((i) => i.variantId === w.to[0])?.onHand).toBe(0);
    expect(t.stock.movements).toEqual([]);
    expect(logged(error, 'inventory.rekey.pending-exceeds-on-hand')).toHaveLength(1);
  });

  it('leaves an existing target as it is, writes only the minus movement and logs it (Hassan M2)', async () => {
    const t = setUp();
    const w = world(t, 1);
    const source = t.ids.next<'InventorySource'>();
    stockItem(t, w, w.from[0]!, 40, source);
    const target = stockItem(t, w, w.to[0]!, 7, source);

    await t.rekey.execute(system(code), w.input());

    expect(t.stock.items.find((i) => i.id === target.id)).toMatchObject({
      onHand: 7,
      retired: false,
    });
    expect(t.stock.items.filter((i) => i.variantId === w.to[0])).toHaveLength(1);
    expect(t.stock.movements.map((m) => [m.variantId, m.delta])).toEqual([[w.from[0], -40]]);
    expect(logged(warn, 'inventory.rekey.target-exists')).toHaveLength(1);
  });

  it('only retires what is left when the Offer tombstone exists, and moves nothing', async () => {
    const t = setUp();
    const w = world(t, 1);
    stockItem(t, w, w.from[0]!, 50);
    stockItem(t, w, w.to[0]!, 8);
    stockItem(t, w, w.to[0]!, 9, undefined, true);
    t.stock.offerRetired = true;

    const result = await t.rekey.execute(system(code), w.input());

    expect(result).toMatchObject({ ok: true, value: { sourceItems: 2 } });
    expect(t.stock.items.every((i) => i.retired)).toBe(true);
    expect(t.stock.movements).toEqual([]);
    expect(t.stock.tombstones).toEqual([]);
    expect(t.stock.calls).not.toContain('insert');
  });

  it('retires the source of a pair whose new Variant was removed, without moving, and logs the quantity', async () => {
    const t = setUp();
    const w = world(t, 2);
    const dropped = stockItem(t, w, w.from[0]!, 60);
    stockItem(t, w, w.from[1]!, 10);
    t.stock.retiredVariants = new Set([w.to[0]!]);

    await t.rekey.execute(system(code), w.input());

    expect(t.stock.items.find((i) => i.id === dropped.id)!.retired).toBe(true);
    expect(t.stock.items.filter((i) => i.variantId === w.to[0])).toEqual([]);
    expect(t.stock.items.find((i) => i.variantId === w.to[1])?.onHand).toBe(10);
    const [[entry]] = logged(warn, 'inventory.rekey.stock-dropped') as [[Record<string, unknown>]];
    expect(entry).toMatchObject({ quantity: 60, fromVariantId: w.from[0], toVariantId: w.to[0] });
    expect(t.stock.movements).toHaveLength(2);
  });

  it('handles a second event for the same Offer by finding the old items retired', async () => {
    const t = setUp();
    const w = world(t, 1);
    stockItem(t, w, w.from[0]!, 25);
    await t.rekey.execute(system(code), w.input());
    const after = JSON.stringify(t.stock.items);
    const movements = t.stock.movements.length;

    const again = await t.rekey.execute(system(code), w.input());

    expect(again).toMatchObject({ ok: true, value: { code: 'inventory.rekeyed', sourceItems: 0 } });
    expect(JSON.stringify(t.stock.items)).toBe(after);
    expect(t.stock.movements).toHaveLength(movements);
  });

  it('stops at the inbox when the same delivery arrives twice', async () => {
    const t = setUp();
    const w = world(t, 1);
    stockItem(t, w, w.from[0]!, 25);
    const input = w.input();
    await t.rekey.execute(system(code), input);

    const again = await t.rekey.execute(system(code), input);

    expect(again).toEqual({ ok: true, value: { code: 'inventory.rekey.already-handled' } });
    expect(t.stock.movements).toHaveLength(2);
  });

  it('refuses a non-system actor', async () => {
    const t = setUp();
    const w = world(t, 1);
    const seller = testCallContext(
      market(code),
      testAuthenticatedActor(market(code), {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId: w.sellerId,
      }),
    );

    const result = await t.rekey.execute(seller, w.input());

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(t.offers.calls).toBe(0);
  });

  describe('a mapping or Offer that fails the checks changes nothing', () => {
    const cap = () => policies.maxVariantsPerProduct(market(code));
    const cases: [
      string,
      (w: ReturnType<typeof world>, t: Setup) => Partial<RekeyMovedOfferInput>,
    ][] = [
      ['unequal lists', (w) => ({ toVariantIds: w.to.slice(1) })],
      ['an empty mapping', () => ({ fromVariantIds: [], toVariantIds: [] })],
      ['a repeated from', (w) => ({ fromVariantIds: [w.from[0]!, w.from[0]!] })],
      ['a repeated to', (w) => ({ toVariantIds: [w.to[0]!, w.to[0]!] })],
      ['a from equal to a to', (w) => ({ toVariantIds: [w.from[0]!, w.to[1]!] })],
      ['the same product on both sides', (w) => ({ fromProductId: w.toProductId })],
    ];
    it.each(cases)('%s', async (_name, over) => {
      const t = setUp();
      const w = world(t, 2);
      stockItem(t, w, w.from[0]!, 5);

      const result = await t.rekey.execute(system(code), w.input(over(w, t)));

      expect(result).toEqual({ ok: false, error: { code: 'inventory.rekey.invalid-mapping' } });
      expect(t.offers.calls).toBe(0);
      expect(t.stock.calls).toEqual([]);
      expect(t.stock.movements).toEqual([]);
    });

    it('more pairs than the Market allows', async () => {
      const t = setUp();
      const w = world(t, cap() + 1);

      const result = await t.rekey.execute(system(code), w.input());

      expect(result).toEqual({ ok: false, error: { code: 'inventory.rekey.invalid-mapping' } });
      expect(t.stock.calls).toEqual([]);
    });

    it('exactly the allowed number of pairs is accepted', async () => {
      const t = setUp();
      const w = world(t, cap());

      const result = await t.rekey.execute(system(code), w.input());

      expect(result.ok).toBe(true);
    });

    const mismatches: [string, (w: ReturnType<typeof world>, t: Setup) => void][] = [
      ['an unknown Offer', (w, t) => t.offers.offers.delete(w.offerId)],
      [
        'a deleted Offer',
        (w, t) =>
          t.offers.offers.set(w.offerId, { ...t.offers.offers.get(w.offerId)!, deleted: true }),
      ],
      [
        'an Offer on another product',
        (w, t) =>
          t.offers.offers.set(w.offerId, {
            ...t.offers.offers.get(w.offerId)!,
            productId: t.ids.next<'Product'>(),
          }),
      ],
      [
        'a to Variant that is not a sell unit',
        (w, t) =>
          t.offers.offers.set(w.offerId, {
            ...t.offers.offers.get(w.offerId)!,
            sellUnitVariantIds: new Set([w.to[0]!]),
          }),
      ],
    ];
    it.each(mismatches)('%s', async (_name, change) => {
      const t = setUp();
      const w = world(t, 2);
      stockItem(t, w, w.from[0]!, 5);
      change(w, t);

      const result = await t.rekey.execute(system(code), w.input());

      expect(result).toEqual({ ok: false, error: { code: 'inventory.rekey.offer-mismatch' } });
      expect(t.stock.calls).toEqual([]);
      expect(t.stock.movements).toEqual([]);
      expect(error).toHaveBeenCalled();
    });

    it('an item of another seller on the Offer', async () => {
      const t = setUp();
      const w = world(t, 1);
      const foreign = stockItem(t, w, w.from[0]!, 5);
      t.stock.items = [{ ...foreign, sellerId: t.ids.next<'Seller'>() }];

      const result = await t.rekey.execute(system(code), w.input());

      expect(result).toEqual({ ok: false, error: { code: 'inventory.rekey.offer-mismatch' } });
      expect(t.stock.movements).toEqual([]);
    });
  });

  it('lets a catalog failure through, so the delivery is retried', async () => {
    const t = setUp();
    const w = world(t, 1);
    t.offers.unavailable = true;

    await expect(t.rekey.execute(system(code), w.input())).rejects.toThrow('catalog down');
    expect(t.stock.calls).toEqual([]);
  });

  it('fails without a change when the lock set is over the statement cap', async () => {
    const t = setUp();
    const w = world(t, 1);
    for (let i = 0; i < 1001; i += 1) stockItem(t, w, w.from[0]!, 1);

    const result = await t.rekey.execute(system(code), w.input());

    expect(result).toEqual({ ok: false, error: { code: 'inventory.rekey.lock-set-too-large' } });
    expect(t.stock.calls).toEqual(['read']);
    expect(t.stock.movements).toEqual([]);
  });
});
