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
import { TransactionConflictError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_RESERVE_LINES, type ReserveRequest } from '../../contracts/ordering-port';
import { Reservation } from '../../domain/reservation';
import { SellerInventory } from '../../domain/seller-inventory';
import type { StoredSignal } from '../../domain/stock';
import { ConfigInventoryPolicyProvider } from '../../infrastructure/config-inventory-policy-provider';
import type {
  AvailabilitySignalRepository,
  NewAvailabilitySignal,
} from '../ports/availability-signal.repository';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import type { StockItemRow } from '../ports/stock.repository';
import { ExpireReservations } from './expire-reservations.use-case';
import { InMemoryReservations } from './in-memory-reservations';
import { ReleaseOwnReservation } from './release-own-reservation.use-case';
import { ReleaseReservation } from './release-reservation.use-case';
import { Reserve } from './reserve.use-case';

// Inventory slice 4 in memory (inventory design 3.1, 4.2, 5.1; AC 1 to 4, 12, 13) on both Market
// fixtures: the reservation duration (AU 15, ZZ 10), default cap D (AU 10, ZZ 4) and low-stock
// threshold (AU 10, ZZ 3) differ. PostgreSQL behaviour (the real lock, rollback of the supersede,
// concurrency, the constraints) is in test/db/inventory-reservations.db-spec.ts.

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
  const inventories = new FakeInventories();
  const reservations = new InMemoryReservations();
  const signals = new FakeSignals();
  const events: PendingEvent[] = [];
  const outbox: OutboxWriter = {
    append: (_c, appended) => {
      events.push(...appended);
      return Promise.resolve();
    },
  };
  const units: UnitOfWorkOptions[] = [];
  const behaviour: { throwOnRun: Error | null } = { throwOnRun: null };
  const unitOfWork: UnitOfWork = {
    run: <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      o: UnitOfWorkOptions = {},
    ) => {
      units.push(o);
      if (behaviour.throwOnRun !== null) return Promise.reject(behaviour.throwOnRun);
      return work();
    },
    runOnce: () => Promise.reject(new Error('not used')),
  };
  const deps = { unitOfWork, reservations, inventories, policies, signals, outbox, ids, clock };
  return {
    clock,
    ids,
    inventories,
    reservations,
    signals,
    events,
    units,
    behaviour,
    reserve: new Reserve(gate, deps),
    releaseOwn: new ReleaseOwnReservation(gate, deps),
    release: new ReleaseReservation(gate, deps),
    expire: new ExpireReservations(gate, deps),
  };
}
type T = ReturnType<typeof setUp>;

describe.each(['AU', 'ZZ'] as const)('inventory reservations in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const config = markets.get(testMarketId(code));
  const minutes = config.inventory!.reservationMinutes;
  const cap = config.inventory!.defaultCustomerCap;
  const threshold = config.inventory!.defaultLowStockThreshold;
  const high = threshold + 20;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const customer = (t: T): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId: null,
      }),
    );

  /** One seller with two sources (priority 1, 2) and `count` sell units; stock per source given. */
  function world(t: T, stock: readonly (readonly [number, number])[]) {
    const sellerId = t.ids.next<'Seller'>();
    const base = SellerInventory.createWithDefaultSource({
      id: t.ids.next<'SellerInventory'>(),
      defaultSourceId: t.ids.next<'InventorySource'>(),
      sellerId,
      marketId: market.marketId,
      now: START,
    });
    const added = base.addSource({
      id: t.ids.next<'InventorySource'>(),
      name: 'Second',
      address: null,
      timeZone: null,
      maxSources: 4,
      now: START,
    });
    if (!added.ok) throw new Error('addSource');
    void t.inventories.add(market, added.value);
    const [first, second] = added.value.state.sources;
    const units = stock.map(([a, b]) => {
      const offerId = t.ids.next<'Offer'>();
      const variantId = t.ids.next<'Variant'>();
      const rows: StockItemRow[] = [[first!.id, a] as const, [second!.id, b] as const].map(
        ([sourceId, onHand]) => ({
          id: t.ids.next<'StockItem'>(),
          offerId,
          variantId,
          sourceId,
          sellerId,
          onHand,
          retired: false,
          version: 1,
        }),
      );
      t.reservations.items.push(...rows);
      return { offerId, variantId, rows };
    });
    return { sellerId, units };
  }

  const request = (
    t: T,
    lines: readonly { offerId: Id<'Offer'>; variantId: Id<'Variant'> }[],
    quantity = 1,
    checkoutRef: string = t.ids.next<'Checkout'>(),
  ): ReserveRequest => ({
    checkoutRef,
    lines: lines.map((line) => ({ ...line, quantity })),
  });

  describe('inventory.reserve', () => {
    it('holds the whole cart on the first source in priority order, until now + duration', async () => {
      const t = setUp();
      const { units } = world(t, [
        [high, high],
        [high, high],
      ]);

      const result = await t.reserve.execute(customer(t), request(t, units, 2));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.lines).toHaveLength(2);
      expect(result.value.expiresAt.epochMilliseconds - START.epochMilliseconds).toBe(
        minutes * 60_000,
      );
      const stored = [...t.reservations.stored.values()][0]!;
      expect(stored.state.lines.map((l) => l.stockItemId).sort()).toEqual(
        units.map((u) => u.rows[0]!.id).sort(),
      );
      expect(t.units.at(-1)).toEqual({ lockTimeoutMs: 3000 });
    });

    it('never splits a line: it moves to the next source that fits whole (Q3, AC 2)', async () => {
      const t = setUp();
      const { units } = world(t, [[2, high]]);

      const result = await t.reserve.execute(customer(t), request(t, units, 3));

      expect(result.ok).toBe(true);
      const stored = [...t.reservations.stored.values()][0]!;
      expect(stored.state.lines[0]!.stockItemId).toBe(units[0]!.rows[1]!.id);
    });

    it('is all or nothing: one short line refuses the call and names it with a reason, no number (AC 3)', async () => {
      const t = setUp();
      const { units } = world(t, [
        [high, 0],
        [1, 1],
      ]);
      const [plenty, scarce] = units as [(typeof units)[number], (typeof units)[number]];
      // The seller's own limit lifts the cap, so the short line fails on stock, not on the cap.
      t.reservations.limits.set(scarce.offerId, 5);

      const result = await t.reserve.execute(customer(t), {
        checkoutRef: t.ids.next<'Checkout'>(),
        lines: [
          { offerId: plenty.offerId, variantId: plenty.variantId, quantity: 1 },
          { offerId: scarce.offerId, variantId: scarce.variantId, quantity: 2 },
        ],
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'inventory.insufficient',
          details: {
            lines: [{ offerId: scarce.offerId, variantId: scarce.variantId, reason: 'not-enough' }],
          },
        },
      });
      expect(t.reservations.stored.size).toBe(0);
    });

    it('answers out for a sell unit with no stock and retired for one whose items are retired', async () => {
      const t = setUp();
      const { units } = world(t, [
        [0, 0],
        [high, high],
      ]);
      const [empty, gone] = units as [(typeof units)[number], (typeof units)[number]];
      for (const row of gone.rows)
        t.reservations.items[t.reservations.items.indexOf(row)] = { ...row, retired: true };
      const nothing = { offerId: t.ids.next<'Offer'>(), variantId: t.ids.next<'Variant'>() };

      const result = await t.reserve.execute(customer(t), request(t, [empty, gone, nothing]));

      expect(result).toMatchObject({
        ok: false,
        error: {
          details: {
            lines: [
              { offerId: empty.offerId, reason: 'out' },
              { offerId: gone.offerId, reason: 'retired' },
              { offerId: nothing.offerId, reason: 'out' },
            ],
          },
        },
      });
    });

    describe('the per-customer cap (design 5.1)', () => {
      it('is D while in stock, and over it the line is refused with over-limit', async () => {
        const t = setUp();
        const { units } = world(t, [[high, high]]);

        const ok = await t.reserve.execute(customer(t), request(t, units, cap));
        const over = await t.reserve.execute(customer(t), request(t, units, cap + 1));

        expect(ok.ok).toBe(true);
        expect(over).toMatchObject({
          ok: false,
          error: { details: { lines: [{ reason: 'over-limit' }] } },
        });
      });

      it('is min(D, ceil(onlyLeft / 2)) while low, rounded up so the last unit can be taken', async () => {
        const t = setUp();
        const { units } = world(t, [
          [threshold, 0],
          [1, 0],
        ]);
        const [low, last] = units as [(typeof units)[number], (typeof units)[number]];
        const half = Math.min(cap, Math.ceil(threshold / 2));

        const tooMany = await t.reserve.execute(customer(t), request(t, [low], half + 1));
        const exactly = await t.reserve.execute(customer(t), request(t, [low], half));
        const lastUnit = await t.reserve.execute(customer(t), request(t, [last], 1));

        expect(tooMany).toMatchObject({
          error: { details: { lines: [{ reason: 'over-limit' }] } },
        });
        expect(exactly.ok).toBe(true);
        expect(lastUnit.ok).toBe(true);
      });

      it('is the Offer limit when the seller set one', async () => {
        const t = setUp();
        const { units } = world(t, [[high, high]]);
        t.reservations.limits.set(units[0]!.offerId, 2);

        const over = await t.reserve.execute(customer(t), request(t, units, 3));
        const fits = await t.reserve.execute(customer(t), request(t, units, 2));

        expect(over.ok).toBe(false);
        expect(fits.ok).toBe(true);
      });
    });

    it('returns the same reservation for a replay with the same checkout and lines (design 10)', async () => {
      const t = setUp();
      const { units } = world(t, [[high, high]]);
      const who = customer(t);
      const same = request(t, units, 2);

      const first = await t.reserve.execute(who, same);
      const again = await t.reserve.execute(who, same);

      expect(again).toEqual(first);
      expect(t.reservations.stored.size).toBe(1);
      expect(t.reservations.lockCalls).toHaveLength(1);
    });

    it("releases the holder's earlier reservation as superseded when the lines differ (design 3.1)", async () => {
      const t = setUp();
      const { units } = world(t, [[high, high]]);
      const who = customer(t);
      const first = await t.reserve.execute(who, request(t, units, 2));
      if (!first.ok) throw new Error('first');

      const second = await t.reserve.execute(who, request(t, units, 3));

      expect(second.ok).toBe(true);
      const old = t.reservations.stored.get(first.value.reservationId)!;
      expect(old.state).toMatchObject({ status: 'released', releaseCause: 'superseded' });
      const active = [...t.reservations.stored.values()].filter((r) => r.state.status === 'active');
      expect(active).toHaveLength(1);
      // The previous reservation does not count against the new one (design 4.2 step 3).
      expect(
        (await t.reservations.heldQuantities(market, [units[0]!.rows[0]!.id], t.clock.now())).get(
          units[0]!.rows[0]!.id,
        ),
      ).toBe(3);
    });

    it("locks every item of every sell unit, and the previous reservation's, in one call in ascending id order", async () => {
      const t = setUp();
      const { units } = world(t, [
        [high, high],
        [high, high],
      ]);
      const who = customer(t);
      await t.reserve.execute(who, request(t, [units[0]!]));
      t.reservations.lockCalls.length = 0;

      await t.reserve.execute(who, request(t, [units[1]!]));

      expect(t.reservations.lockCalls).toHaveLength(1);
      const ids = t.reservations.lockCalls[0]!;
      expect([...ids].sort()).toEqual(
        [...units[0]!.rows, ...units[1]!.rows].map((r) => r.id).sort(),
      );
    });

    it('derives expiry at read: after the duration another customer gets the stock with no job (AC 4)', async () => {
      const t = setUp();
      const { units } = world(t, [[1, 0]]);
      const a = await t.reserve.execute(customer(t), request(t, units));
      const blocked = await t.reserve.execute(customer(t), request(t, units));

      t.clock.advance(Temporal.Duration.from({ minutes }));
      const b = await t.reserve.execute(customer(t), request(t, units));

      expect(a.ok).toBe(true);
      expect(blocked.ok).toBe(false);
      expect(b.ok).toBe(true);
    });

    it('publishes the signal when the status changes (low, then out)', async () => {
      const t = setUp();
      const { units } = world(t, [[threshold + 3, 0]]);

      await t.reserve.execute(customer(t), request(t, units, 1));
      await t.reserve.execute(customer(t), request(t, units, 2));

      expect(t.events.map((e) => e.type)).toEqual([
        'inventory.availability-changed.v1',
        'inventory.availability-changed.v1',
        'inventory.low-stock-reached.v1',
      ]);
    });

    it('answers conflict.retry on a lock timeout or deadlock, and on a same-holder race', async () => {
      const t = setUp();
      const { units } = world(t, [[high, high]]);

      t.reservations.holderConflictOnInsert = true;
      const race = await t.reserve.execute(customer(t), request(t, units));
      t.behaviour.throwOnRun = new TransactionConflictError('55P03');
      const timeout = await t.reserve.execute(customer(t), request(t, units));

      expect(race).toEqual({ ok: false, error: { code: 'conflict.retry' } });
      expect(timeout).toEqual({ ok: false, error: { code: 'conflict.retry' } });
    });

    it('refuses every actor but a signed-in customer, and malformed input', async () => {
      const t = setUp();
      const { units } = world(t, [[high, high]]);
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: t.ids.next<'Account'>(),
          sessionId: t.ids.next<'Session'>(),
          sellerId: t.ids.next<'Seller'>(),
        }),
      );
      const good = request(t, units);
      const many = Array.from({ length: MAX_RESERVE_LINES + 1 }, () => ({
        offerId: t.ids.next<'Offer'>(),
        variantId: t.ids.next<'Variant'>(),
        quantity: 1,
      }));
      const line = good.lines[0]!;

      expect(await t.reserve.execute(testCallContext(market, 'anonymous'), good)).toMatchObject({
        error: { code: 'access.unauthenticated' },
      });
      expect(await t.reserve.execute(testCallContext(market, 'system'), good)).toMatchObject({
        error: { code: 'access.denied' },
      });
      expect(await t.reserve.execute(seller, good)).toMatchObject({
        error: { code: 'access.denied' },
      });
      const who = customer(t);
      expect(await t.reserve.execute(who, { ...good, lines: many })).toEqual({
        ok: false,
        error: { code: 'batch.too-large' },
      });
      for (const bad of [
        { ...good, checkoutRef: 'nope' },
        { ...good, lines: [] },
        { ...good, lines: [{ ...line, quantity: 0 }] },
        { ...good, lines: [{ ...line, quantity: 1.5 }] },
        { ...good, lines: [line, line] },
        { ...good, lines: [{ ...line, offerId: 'x' as Id<'Offer'> }] },
      ]) {
        expect(await t.reserve.execute(who, bad)).toMatchObject({
          ok: false,
          error: { code: 'validation.failed' },
        });
      }
      expect(t.reservations.stored.size).toBe(0);
    });
  });

  describe('releasing', () => {
    async function held(t: T) {
      const { units } = world(t, [[threshold + 1, 0]]);
      const who = customer(t);
      const reserved = await t.reserve.execute(who, request(t, units, 2));
      if (!reserved.ok) throw new Error('reserve');
      return { units, who, id: reserved.value.reservationId };
    }

    it('lets the holder release their own hold, which makes the stock sellable at once', async () => {
      const t = setUp();
      const { who, id, units } = await held(t);

      const result = await t.releaseOwn.execute(who, { reservationId: id });

      expect(result).toEqual({ ok: true, value: { reservationId: id } });
      expect(t.reservations.stored.get(id)!.state).toMatchObject({
        status: 'released',
        releaseCause: 'customer',
      });
      const row = units[0]!.rows[0]!;
      expect(
        (await t.reservations.heldQuantities(market, [row.id], t.clock.now())).get(row.id),
      ).toBe(0);
    });

    it("answers not-found for another customer's reservation and for an unknown id", async () => {
      const t = setUp();
      const { id } = await held(t);

      const other = await t.releaseOwn.execute(customer(t), { reservationId: id });
      const unknown = await t.releaseOwn.execute(customer(t), {
        reservationId: t.ids.next<'Reservation'>(),
      });

      expect(other).toEqual({ ok: false, error: { code: 'inventory.reservation.not-found' } });
      expect(unknown).toEqual(other);
      expect(t.reservations.stored.get(id)!.state.status).toBe('active');
    });

    it('is idempotent and keeps the first cause; a committed reservation is refused', async () => {
      const t = setUp();
      const { who, id } = await held(t);
      await t.releaseOwn.execute(who, { reservationId: id });

      const system = await t.release.execute(testCallContext(market, 'system'), {
        reservationId: id,
        cause: 'payment-failed',
      });

      expect(system.ok).toBe(true);
      expect(t.reservations.stored.get(id)!.state.releaseCause).toBe('customer');

      const committed = Reservation.fromStored({
        ...t.reservations.stored.get(id)!.state,
        status: 'committed',
        releaseCause: null,
      });
      t.reservations.stored.set(id, committed);
      expect(
        await t.release.execute(testCallContext(market, 'system'), {
          reservationId: id,
          cause: 'cancelled',
        }),
      ).toEqual({ ok: false, error: { code: 'inventory.reservation.committed' } });
    });

    it('lets the system release with cancelled or payment-failed only, and only the system', async () => {
      const t = setUp();
      const { who, id } = await held(t);
      const system = testCallContext(market, 'system');

      expect(await t.release.execute(who, { reservationId: id, cause: 'cancelled' })).toMatchObject(
        {
          error: { code: 'access.denied' },
        },
      );
      expect(
        await t.release.execute(system, { reservationId: id, cause: 'customer' as 'cancelled' }),
      ).toMatchObject({ error: { code: 'validation.failed' } });
      expect(
        await t.release.execute(system, { reservationId: id, cause: 'payment-failed' }),
      ).toEqual({
        ok: true,
        value: { reservationId: id },
      });
      expect(t.reservations.stored.get(id)!.state.releaseCause).toBe('payment-failed');
    });
  });

  describe('inventory.expire-reservations', () => {
    it('marks only due reservations expired and publishes the signal change (design 11)', async () => {
      const t = setUp();
      const { units } = world(t, [[threshold, 0]]);
      const early = await t.reserve.execute(customer(t), request(t, units, 1));
      t.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      const late = await t.reserve.execute(customer(t), request(t, units, 1));
      if (!early.ok || !late.ok) throw new Error('reserve');
      t.events.length = 0;

      t.clock.advance(Temporal.Duration.from({ minutes }).subtract({ seconds: 30 }));
      const run = await t.expire.execute(testCallContext(market, 'system'), {});

      expect(run).toEqual({ ok: true, value: { expired: 1, contended: 0 } });
      expect(t.reservations.stored.get(early.value.reservationId)!.state.status).toBe('expired');
      expect(t.reservations.stored.get(late.value.reservationId)!.state.status).toBe('active');
      expect(t.events.map((e) => e.type)).toContain('inventory.availability-changed.v1');
    });

    it('is safe to run twice and refuses a non-system caller', async () => {
      const t = setUp();
      const { units } = world(t, [[high, 0]]);
      await t.reserve.execute(customer(t), request(t, units, 1));
      t.clock.advance(Temporal.Duration.from({ minutes: minutes + 1 }));
      const system = testCallContext(market, 'system');

      const first = await t.expire.execute(system, {});
      const second = await t.expire.execute(system, {});

      expect(first).toEqual({ ok: true, value: { expired: 1, contended: 0 } });
      expect(second).toEqual({ ok: true, value: { expired: 0, contended: 0 } });
      expect(await t.expire.execute(customer(t), {})).toMatchObject({
        error: { code: 'access.denied' },
      });
    });
  });
});
