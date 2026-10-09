import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PendingEvent } from '@mondapac/shared-kernel';
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
import type {
  AvailabilitySignalRepository,
  NewAvailabilitySignal,
} from '../ports/availability-signal.repository';
import type {
  NewRetirementTombstone,
  RetirementTarget,
  StockItemRow,
  StockRepository,
} from '../ports/stock.repository';
import type { StoredSignal } from '../../domain/stock';
import { RetireSellUnits } from './retire-sell-units.use-case';

// Inventory slice 2, part 4 in memory (inventory design 3.5, 4.5): the retirement handler on
// both Market fixtures. PostgreSQL behaviour (locks, the tombstone keys, the race with
// set-stock-level) is covered by test/db/inventory-retire-sell-units.db-spec.ts.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);

class FakeStock implements StockRepository {
  items: StockItemRow[] = [];
  readonly tombstones: NewRetirementTombstone[] = [];
  readonly retiredAt = new Map<string, Temporal.Instant>();
  readonly calls: string[] = [];
  /** Items another unit retires between the read and the lock. */
  retireBeforeLock = new Set<string>();
  /** Makes `retireItems` change fewer rows than asked, as a lost lock would. */
  shortRetire = false;

  activeItemIds(_m: MarketContext, target: RetirementTarget) {
    this.calls.push('read');
    return Promise.resolve(
      this.items
        .filter((i) => !i.retired)
        .filter((i) =>
          target.scope === 'offer'
            ? i.offerId === target.offerId
            : i.variantId === target.variantId,
        )
        .map((i) => i.id)
        .sort(),
    );
  }
  lockItems(_m: MarketContext, ids: readonly Id<'StockItem'>[]) {
    this.calls.push('lock');
    this.items = this.items.map((i) =>
      this.retireBeforeLock.has(i.id) ? { ...i, retired: true } : i,
    );
    return Promise.resolve(this.items.filter((i) => ids.includes(i.id)));
  }
  recordTombstone(_m: MarketContext, tombstone: NewRetirementTombstone) {
    this.calls.push('tombstone');
    this.tombstones.push(tombstone);
    return Promise.resolve();
  }
  retireItems(_m: MarketContext, ids: readonly Id<'StockItem'>[], at: Temporal.Instant) {
    this.calls.push('retire');
    let changed = 0;
    this.items = this.items.map((i) => {
      if (!ids.includes(i.id) || i.retired) return i;
      changed += 1;
      this.retiredAt.set(i.id, at);
      return { ...i, retired: true };
    });
    return Promise.resolve(this.shortRetire ? changed - 1 : changed);
  }
  lockSellUnit() {
    return Promise.reject(new Error('not used'));
  }
  isSellUnitRetired() {
    return Promise.reject(new Error('not used'));
  }
  heldQuantities() {
    return Promise.reject(new Error('not used'));
  }
  insertItem() {
    return Promise.reject(new Error('not used'));
  }
  setOnHand() {
    return Promise.reject(new Error('not used'));
  }
  appendMovement() {
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

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const stock = new FakeStock();
  const signals = new FakeSignals();
  const events: PendingEvent[] = [];
  const outbox: OutboxWriter = {
    append: (_c, appended) => {
      events.push(...appended);
      return Promise.resolve();
    },
  };
  const options: (UnitOfWorkOptions | undefined)[] = [];
  const handled = new Set<string>();
  const once = fakeRunOnce(handled);
  const unitOfWork: UnitOfWork = {
    run: () => Promise.reject(new Error('not used')),
    runOnce: (market, delivery, work, opts) => {
      options.push(opts);
      return once(market, delivery, work);
    },
  };
  const retire = new RetireSellUnits(gate, { unitOfWork, stock, signals, outbox, ids, clock });
  return { ids, stock, signals, events, options, retire, handled, clock };
}

type Setup = ReturnType<typeof setUp>;
const market = (code: string): MarketContext => testMarketContext(code, 'default');
const system = (code: string) => testCallContext(market(code), 'system');
const delivery = (t: Setup): EventDelivery => ({
  eventId: t.ids.next<'event'>(),
  subscriber: 'inventory.retire-on-offer-deleted',
  attempt: 1,
});

function item(
  t: Setup,
  offerId: Id<'Offer'>,
  variantId: Id<'Variant'>,
  sellerId: Id<'Seller'>,
  onHand = 5,
  retired = false,
): StockItemRow {
  return {
    id: t.ids.next<'StockItem'>(),
    offerId,
    variantId,
    sourceId: t.ids.next<'InventorySource'>(),
    sellerId,
    onHand,
    retired,
    version: 1,
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe.each(['AU', 'ZZ'])('inventory.retire-sell-units in market %s', (code) => {
  const retireOffer = (t: Setup, offerId: Id<'Offer'>) =>
    t.retire.execute(system(code), {
      delivery: delivery(t),
      target: { scope: 'offer', offerId },
      sourceAggregateVersion: 3,
    });

  it('retires every item of the Offer, records the tombstone and marks each sell unit out', async () => {
    const t = setUp();
    const seller = t.ids.next<'Seller'>();
    const offer = t.ids.next<'Offer'>();
    const [v1, v2] = [t.ids.next<'Variant'>(), t.ids.next<'Variant'>()];
    t.stock.items = [
      item(t, offer, v1, seller),
      item(t, offer, v1, seller),
      item(t, offer, v2, seller),
    ];
    for (const i of t.stock.items) {
      t.signals.rows.set(`${i.offerId}|${i.variantId}`, {
        id: t.ids.next<'AvailabilitySignal'>(),
        offerId: i.offerId,
        variantId: i.variantId,
        sellerId: seller,
        status: 'in-stock',
        onlyLeft: null,
        changedAt: START,
        version: 1,
      });
    }

    const result = await retireOffer(t, offer);

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 3, sellUnits: 2 },
    });
    expect(t.stock.items.every((i) => i.retired)).toBe(true);
    expect(t.stock.tombstones).toEqual([
      expect.objectContaining({
        target: { scope: 'offer', offerId: offer },
        sourceAggregateVersion: 3,
      }),
    ]);
    expect([...t.signals.rows.values()].map((s) => [s.status, s.version])).toEqual([
      ['out', 2],
      ['out', 2],
    ]);
    expect(t.events.map((e) => e.type)).toEqual([
      'inventory.availability-changed.v1',
      'inventory.availability-changed.v1',
    ]);
    // The order of the design: read, lock, tombstone, retire.
    expect(t.stock.calls).toEqual(['read', 'lock', 'tombstone', 'retire']);
    expect(t.options).toEqual([{ isolation: 'serializable', timeoutMs: MAX_UNIT_TIMEOUT_MS }]);
  });

  it('retires the Variant across every Offer, of any seller, and leaves other Variants alone', async () => {
    const t = setUp();
    const [s1, s2] = [t.ids.next<'Seller'>(), t.ids.next<'Seller'>()];
    const [o1, o2] = [t.ids.next<'Offer'>(), t.ids.next<'Offer'>()];
    const [gone, kept] = [t.ids.next<'Variant'>(), t.ids.next<'Variant'>()];
    t.stock.items = [
      item(t, o1, gone, s1),
      item(t, o2, gone, s2),
      item(t, o2, gone, s2),
      item(t, o1, kept, s1),
    ];

    const result = await t.retire.execute(system(code), {
      delivery: delivery(t),
      target: { scope: 'variant', variantId: gone },
      sourceAggregateVersion: 2,
    });

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 3, sellUnits: 2 },
    });
    expect(t.stock.items.map((i) => i.retired)).toEqual([true, true, true, false]);
    expect(t.stock.tombstones[0]!.target).toEqual({ scope: 'variant', variantId: gone });
    // Each signal is created for its own seller.
    expect([...t.signals.rows.values()].map((s) => s.sellerId).sort()).toEqual([s1, s2].sort());
  });

  it('records the tombstone even when nothing is stocked yet, and writes no event', async () => {
    const t = setUp();

    const result = await retireOffer(t, t.ids.next<'Offer'>());

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 0, sellUnits: 0 },
    });
    expect(t.stock.tombstones).toHaveLength(1);
    expect(t.stock.calls).toEqual(['read', 'tombstone']);
    expect(t.events).toEqual([]);
  });

  it('skips items that are already retired and keeps their first instant (one way)', async () => {
    const t = setUp();
    const seller = t.ids.next<'Seller'>();
    const offer = t.ids.next<'Offer'>();
    const variant = t.ids.next<'Variant'>();
    const early = item(t, offer, variant, seller, 5, true);
    const live = item(t, offer, variant, seller);
    t.stock.items = [early, live];

    const result = await retireOffer(t, offer);

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 1, sellUnits: 1 },
    });
    expect(t.stock.retiredAt.has(early.id)).toBe(false);
    expect(t.stock.retiredAt.get(live.id)).toEqual(START);
  });

  it('ignores an item another unit retired between the read and the lock', async () => {
    const t = setUp();
    const seller = t.ids.next<'Seller'>();
    const offer = t.ids.next<'Offer'>();
    const variant = t.ids.next<'Variant'>();
    const [a, b] = [item(t, offer, variant, seller), item(t, offer, variant, seller)];
    t.stock.items = [a, b];
    t.stock.retireBeforeLock = new Set([a.id]);

    const result = await retireOffer(t, offer);

    expect(result).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 1, sellUnits: 1 },
    });
    expect(t.stock.retiredAt.has(a.id)).toBe(false);
  });

  it('is idempotent: the same delivery settles at the inbox and writes nothing again', async () => {
    const t = setUp();
    const seller = t.ids.next<'Seller'>();
    const offer = t.ids.next<'Offer'>();
    t.stock.items = [item(t, offer, t.ids.next<'Variant'>(), seller)];
    const again = delivery(t);
    const run = () =>
      t.retire.execute(system(code), {
        delivery: again,
        target: { scope: 'offer', offerId: offer },
        sourceAggregateVersion: 1,
      });

    await run();
    const second = await run();

    expect(second).toEqual({ ok: true, value: { code: 'inventory.retire.already-handled' } });
    expect(t.stock.tombstones).toHaveLength(1);
    expect(t.events).toHaveLength(1);
  });

  it('a second event for the same target finds nothing active and writes no signal event', async () => {
    const t = setUp();
    const seller = t.ids.next<'Seller'>();
    const offer = t.ids.next<'Offer'>();
    t.stock.items = [item(t, offer, t.ids.next<'Variant'>(), seller)];

    await retireOffer(t, offer);
    const eventsAfterFirst = t.events.length;
    const second = await retireOffer(t, offer);

    expect(second).toEqual({
      ok: true,
      value: { code: 'inventory.retired', items: 0, sellUnits: 0 },
    });
    expect(t.events).toHaveLength(eventsAfterFirst);
    expect(t.stock.tombstones).toHaveLength(2);
  });

  it('rolls back with an error when a locked item cannot be retired', async () => {
    const t = setUp();
    const seller = t.ids.next<'Seller'>();
    const offer = t.ids.next<'Offer'>();
    t.stock.items = [item(t, offer, t.ids.next<'Variant'>(), seller)];
    t.stock.shortRetire = true;

    await expect(retireOffer(t, offer)).rejects.toThrow('retired under its lock');
    expect(t.handled.size).toBe(0);
  });

  it.each(['customer', 'seller', 'anonymous'] as const)(
    'refuses a %s caller before any read',
    async (kind) => {
      const t = setUp();
      const context =
        kind === 'anonymous'
          ? testCallContext(market(code), 'anonymous')
          : testCallContext(
              market(code),
              testAuthenticatedActor(market(code), {
                population: kind,
                accountId: t.ids.next<'Account'>(),
                sessionId: t.ids.next<'Session'>(),
                sellerId: kind === 'seller' ? t.ids.next<'Seller'>() : null,
              }),
            );

      const result = await t.retire.execute(context, {
        delivery: delivery(t),
        target: { scope: 'offer', offerId: t.ids.next<'Offer'>() },
        sourceAggregateVersion: 1,
      });

      expect(result.ok).toBe(false);
      expect(t.stock.calls).toEqual([]);
    },
  );
});
