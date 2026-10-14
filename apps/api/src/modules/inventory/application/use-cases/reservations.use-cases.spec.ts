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
import { InMemoryRateCounters } from '../testing/in-memory-rate-counters';
import { InMemoryReservations } from '../testing/in-memory-reservations';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import type { NewStockMovement, StockRepository } from '../ports/stock.repository';
import { CancelCommittedLine } from './cancel-committed-line.use-case';
import { CommitReservation } from './commit-reservation.use-case';
import { PruneReservations } from './prune-reservations.use-case';
import { RecordShipment } from './record-shipment.use-case';
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
  const counters = new InMemoryRateCounters();
  const counterKeys = new HmacRateCounterKeys(new Uint8Array(32).fill(7));
  const movements: NewStockMovement[] = [];
  const stock = {
    appendMovement: (_m: MarketContext, movement: NewStockMovement) => {
      movements.push(movement);
      return Promise.resolve();
    },
  } as unknown as StockRepository;
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
      // Only the stock unit (the one with a lock wait) fails; the rate-counter units are separate.
      if (behaviour.throwOnRun !== null && o.lockTimeoutMs !== undefined) {
        return Promise.reject(behaviour.throwOnRun);
      }
      return work();
    },
    runOnce: () => Promise.reject(new Error('not used')),
  };
  const deps = {
    unitOfWork,
    reservations,
    inventories,
    policies,
    signals,
    outbox,
    counters,
    counterKeys,
    stock,
    ids,
    clock,
  };
  return {
    clock,
    ids,
    inventories,
    reservations,
    counters,
    movements,
    signals,
    events,
    units,
    behaviour,
    reserve: new Reserve(gate, deps),
    releaseOwn: new ReleaseOwnReservation(gate, deps),
    release: new ReleaseReservation(gate, deps),
    expire: new ExpireReservations(gate, deps),
    commit: new CommitReservation(gate, deps),
    cancelLine: new CancelCommittedLine(gate, deps),
    ship: new RecordShipment(gate, deps),
    prune: new PruneReservations(gate, deps),
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

  describe('the reserve rate limit (design 5.4, M2)', () => {
    it('allows 6 calls per 15 minutes per account, then answers request.throttled with a wait', async () => {
      const t = setUp();
      const { units } = world(t, [[high, high]]);
      const holder = customer(t);

      for (let call = 0; call < 6; call += 1) {
        expect((await t.reserve.execute(holder, request(t, units))).ok).toBe(true);
      }
      const seventh = await t.reserve.execute(holder, request(t, units));

      expect(seventh).toMatchObject({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 15 * 60 },
      });
      // Another account is not affected.
      expect((await t.reserve.execute(customer(t), request(t, units))).ok).toBe(true);
    });

    it('does not count a replay of the live reservation', async () => {
      const t = setUp();
      const { units } = world(t, [[high, high]]);
      const holder = customer(t);
      const same = request(t, units);

      for (let call = 0; call < 12; call += 1) {
        expect((await t.reserve.execute(holder, same)).ok).toBe(true);
      }
      expect([...t.counters.rows.values()].map((row) => row.count)).toEqual([1, 1]);
    });

    it('restarts the 15-minute window, but stops at 30 calls in 24 hours', async () => {
      const t = setUp();
      const { units } = world(t, [[high, high]]);
      const holder = customer(t);

      for (let batch = 0; batch < 5; batch += 1) {
        for (let call = 0; call < 6; call += 1) {
          expect((await t.reserve.execute(holder, request(t, units))).ok).toBe(true);
        }
        t.clock.advance(Temporal.Duration.from({ minutes: 16 }));
      }
      const over = await t.reserve.execute(holder, request(t, units));

      expect(over).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
    });

    it('fails closed with access.unavailable when the counters cannot answer, and holds nothing', async () => {
      const t = setUp();
      const { units } = world(t, [[high, high]]);
      t.counters.failing = true;
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const result = await t.reserve.execute(customer(t), request(t, units));

      expect(result).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(t.reservations.stored.size).toBe(0);
    });
  });

  describe('the cap oracle fix (M1, design 5.1)', () => {
    it('limits an in-stock line with a large Offer limit to threshold + 1, so no refusal depends on the count', async () => {
      const t = setUp();
      const { units } = world(t, [[high, 0]]);
      t.reservations.limits.set(units[0]!.offerId, 90);

      const fits = await t.reserve.execute(customer(t), request(t, units, threshold + 1));
      const over = await t.reserve.execute(customer(t), request(t, units, threshold + 2));

      expect(fits.ok).toBe(true);
      expect(over).toMatchObject({
        ok: false,
        error: { details: { lines: [{ reason: 'over-limit' }] } },
      });
    });

    it('with threshold 0 an in-stock line takes one unit and the rest is over-limit', async () => {
      const t = setUp();
      const { sellerId, units } = world(t, [[40, 0]]);
      const inventory = t.inventories.stored.get(`${market.marketId}|${sellerId}`)!;
      await t.inventories.add(
        market,
        SellerInventory.fromStored({ ...inventory.state, lowStockThreshold: 0 }),
      );

      const two = await t.reserve.execute(customer(t), request(t, units, 2));
      const one = await t.reserve.execute(customer(t), request(t, units, 1));

      expect(two).toMatchObject({
        ok: false,
        error: { details: { lines: [{ reason: 'over-limit' }] } },
      });
      expect(one.ok).toBe(true);
    });
  });

  describe('inventory.commit-reservation (design 3.1, 10)', () => {
    const SYSTEM = () => testCallContext(market, 'system');

    async function reserved(
      t: T,
      quantity = 2,
      stock: readonly (readonly [number, number])[] = [[high, high]],
    ) {
      const w = world(t, stock);
      const checkoutRef = t.ids.next<'Checkout'>();
      const holder = customer(t);
      const result = await t.reserve.execute(holder, request(t, w.units, quantity, checkoutRef));
      if (!result.ok) throw new Error('reserve');
      const commitRequest = {
        reservationId: result.value.reservationId,
        checkoutRef,
        lines: result.value.lines.map((line) => ({
          reservationLineId: line.reservationLineId,
          orderLineId: t.ids.next<'OrderLine'>(),
        })),
      };
      return {
        ...w,
        holder,
        checkoutRef,
        reservationId: result.value.reservationId,
        commitRequest,
      };
    }

    const heldOn = (t: T, item: StockItemRow) =>
      t.reservations.heldQuantities(market, [item.id], t.clock.now()).then((m) => m.get(item.id));

    it('commits a live reservation where it is: lines get their order lines and keep counting after the hold would have expired', async () => {
      const t = setUp();
      const r = await reserved(t);

      const done = await t.commit.execute(SYSTEM(), r.commitRequest);

      expect(done).toEqual({ ok: true, value: { reservationId: r.reservationId } });
      const stored = t.reservations.stored.get(r.reservationId)!;
      expect(stored.state.status).toBe('committed');
      expect(stored.state.lines.map((l) => [l.status, l.orderLineId])).toEqual(
        r.commitRequest.lines.map((l) => ['committed', l.orderLineId]),
      );
      t.clock.advance(Temporal.Duration.from({ minutes: minutes + 5 }));
      expect(await heldOn(t, r.units[0]!.rows[0]!)).toBe(2);
    });

    it('is idempotent with the same mapping and refuses another one, another checkoutRef or a subset', async () => {
      const t = setUp();
      const r = await reserved(t, 1, [
        [high, high],
        [high, high],
      ]);
      await t.commit.execute(SYSTEM(), r.commitRequest);

      expect((await t.commit.execute(SYSTEM(), r.commitRequest)).ok).toBe(true);
      const swapped = {
        ...r.commitRequest,
        lines: [
          { ...r.commitRequest.lines[0]!, orderLineId: t.ids.next<'OrderLine'>() },
          r.commitRequest.lines[1]!,
        ],
      };
      expect(await t.commit.execute(SYSTEM(), swapped)).toMatchObject({
        error: { code: 'inventory.commit-mismatch' },
      });
      expect(
        await t.commit.execute(SYSTEM(), {
          ...r.commitRequest,
          checkoutRef: t.ids.next<'Checkout'>(),
        }),
      ).toMatchObject({ error: { code: 'inventory.commit-mismatch' } });
      const second = await reserved(t, 1, [
        [high, high],
        [high, high],
      ]);
      expect(
        await t.commit.execute(SYSTEM(), {
          ...second.commitRequest,
          lines: second.commitRequest.lines.slice(0, 1),
        }),
      ).toMatchObject({ error: { code: 'inventory.commit-mismatch' } });
      expect(t.reservations.stored.get(second.reservationId)!.state.status).toBe('active');
    });

    it('allocates an expired reservation again under lock, on the next source when the first is gone', async () => {
      const t = setUp();
      const r = await reserved(t, 3, [[3, 10]]);
      t.clock.advance(Temporal.Duration.from({ minutes: minutes + 1 }));
      // Someone else takes the first source meanwhile.
      const taker = await t.reserve.execute(customer(t), request(t, r.units, 3));
      expect(taker.ok).toBe(true);

      const done = await t.commit.execute(SYSTEM(), r.commitRequest);

      expect(done.ok).toBe(true);
      const stored = t.reservations.stored.get(r.reservationId)!;
      expect(stored.state.status).toBe('committed');
      expect(stored.state.lines[0]!.stockItemId).toBe(r.units[0]!.rows[1]!.id);
    });

    it('answers inventory.insufficient and keeps the status when nothing fits any more', async () => {
      const t = setUp();
      const r = await reserved(t, 1, [[high, 0]]);
      t.clock.advance(Temporal.Duration.from({ minutes: minutes + 1 }));
      // The seller sets the stock to 0 once the hold is gone.
      const [first, second] = r.units[0]!.rows;
      t.reservations.items = t.reservations.items.map((item) =>
        item.id === first!.id || item.id === second!.id ? { ...item, onHand: 0 } : item,
      );

      const done = await t.commit.execute(SYSTEM(), r.commitRequest);

      expect(done).toMatchObject({
        ok: false,
        error: { code: 'inventory.insufficient', details: { lines: [{ reason: 'out' }] } },
      });
      expect(t.reservations.stored.get(r.reservationId)!.state.status).toBe('active');
    });

    it('commits one RELEASED as superseded, but refuses one released for another cause', async () => {
      const t = setUp();
      const r = await reserved(t, 1);
      const newer = await t.reserve.execute(r.holder, request(t, r.units, 1));
      expect(newer.ok).toBe(true);
      expect(t.reservations.stored.get(r.reservationId)!.state.releaseCause).toBe('superseded');

      expect((await t.commit.execute(SYSTEM(), r.commitRequest)).ok).toBe(true);
      const committed = t.reservations.stored.get(r.reservationId)!;
      expect(committed.state.status).toBe('committed');
      expect(committed.state.releaseCause).toBe('superseded');

      const f = await reserved(t, 1);
      await t.release.execute(SYSTEM(), {
        reservationId: f.reservationId,
        cause: 'payment-failed',
      });
      expect(await t.commit.execute(SYSTEM(), f.commitRequest)).toMatchObject({
        ok: false,
        error: { code: 'inventory.insufficient' },
      });
      expect(t.reservations.stored.get(f.reservationId)!.state.status).toBe('released');
    });

    it('is for the system actor only, validates its input and answers not-found for an unknown id', async () => {
      const t = setUp();
      const r = await reserved(t);

      expect(await t.commit.execute(customer(t), r.commitRequest)).toMatchObject({
        error: { code: 'access.denied' },
      });
      expect(await t.commit.execute(SYSTEM(), { ...r.commitRequest, lines: [] })).toMatchObject({
        error: { code: 'validation.failed' },
      });
      expect(
        await t.commit.execute(SYSTEM(), {
          ...r.commitRequest,
          reservationId: t.ids.next<'Reservation'>(),
        }),
      ).toMatchObject({ error: { code: 'inventory.reservation.not-found' } });
    });
  });

  describe('cancel and shipment of a committed line (design 3.2, 10)', () => {
    const SYSTEM = () => testCallContext(market, 'system');

    async function committed(t: T, quantity = 2) {
      const w = world(t, [[high, high]]);
      const checkoutRef = t.ids.next<'Checkout'>();
      const result = await t.reserve.execute(
        customer(t),
        request(t, w.units, quantity, checkoutRef),
      );
      if (!result.ok) throw new Error('reserve');
      const orderLineId = t.ids.next<'OrderLine'>();
      const done = await t.commit.execute(SYSTEM(), {
        reservationId: result.value.reservationId,
        checkoutRef,
        lines: [{ reservationLineId: result.value.lines[0]!.reservationLineId, orderLineId }],
      });
      if (!done.ok) throw new Error('commit');
      return { ...w, orderLineId, item: w.units[0]!.rows[0]! };
    }

    const heldOn = (t: T, id: Id<'StockItem'>) =>
      t.reservations.heldQuantities(market, [id], t.clock.now()).then((m) => m.get(id));

    it('cancels a committed line: the units are sellable again, a repeat is fine', async () => {
      const t = setUp();
      const c = await committed(t);
      expect(await heldOn(t, c.item.id)).toBe(2);

      const first = await t.cancelLine.execute(SYSTEM(), { orderLineId: c.orderLineId });
      const again = await t.cancelLine.execute(SYSTEM(), { orderLineId: c.orderLineId });

      expect(first).toEqual({ ok: true, value: { orderLineId: c.orderLineId } });
      expect(again.ok).toBe(true);
      expect(await heldOn(t, c.item.id)).toBe(0);
    });

    it('ships a committed line: on-hand goes down by the quantity once, with a shipment movement', async () => {
      const t = setUp();
      const c = await committed(t);

      await t.ship.execute(SYSTEM(), { orderLineId: c.orderLineId });
      await t.ship.execute(SYSTEM(), { orderLineId: c.orderLineId });

      expect(t.reservations.shipped).toEqual([{ id: c.item.id, quantity: 2 }]);
      expect(t.movements).toHaveLength(1);
      expect(t.movements[0]).toMatchObject({
        reason: 'shipment',
        stockItemId: c.item.id,
        delta: -2,
        resultingOnHand: high - 2,
      });
      expect(await heldOn(t, c.item.id)).toBe(0);
    });

    it('refuses the opposite command on a finished line and an unknown order line', async () => {
      const t = setUp();
      const shipped = await committed(t);
      await t.ship.execute(SYSTEM(), { orderLineId: shipped.orderLineId });
      const cancelled = await committed(t);
      await t.cancelLine.execute(SYSTEM(), { orderLineId: cancelled.orderLineId });

      expect(
        await t.cancelLine.execute(SYSTEM(), { orderLineId: shipped.orderLineId }),
      ).toMatchObject({
        error: { code: 'inventory.line.final' },
      });
      expect(await t.ship.execute(SYSTEM(), { orderLineId: cancelled.orderLineId })).toMatchObject({
        error: { code: 'inventory.line.final' },
      });
      expect(
        await t.ship.execute(SYSTEM(), { orderLineId: t.ids.next<'OrderLine'>() }),
      ).toMatchObject({ error: { code: 'inventory.line.not-found' } });
    });

    it('takes the stock locks first and refuses a non-system caller', async () => {
      const t = setUp();
      const c = await committed(t);
      const before = t.reservations.lockCalls.length;

      await t.ship.execute(SYSTEM(), { orderLineId: c.orderLineId });

      expect(t.reservations.lockCalls.length).toBe(before + 1);
      expect(t.reservations.lockCalls.at(-1)).toContain(c.item.id);
      expect(await t.ship.execute(customer(t), { orderLineId: c.orderLineId })).toMatchObject({
        error: { code: 'access.denied' },
      });
    });
  });

  describe('inventory.prune-reservations (design 11)', () => {
    it('deletes released and expired reservations 30 days after their last change, never committed or fresh ones', async () => {
      const t = setUp();
      const w = world(t, [[high, high]]);
      const make = async (checkoutRef: string) => {
        const r = await t.reserve.execute(customer(t), request(t, w.units, 1, checkoutRef));
        if (!r.ok) throw new Error('reserve');
        return r.value;
      };
      const old = await make(t.ids.next<'Checkout'>());
      const kept = await make(t.ids.next<'Checkout'>());
      const system = testCallContext(market, 'system');
      await t.release.execute(system, { reservationId: old.reservationId, cause: 'cancelled' });
      t.clock.advance(Temporal.Duration.from({ hours: 31 * 24 }));
      const fresh = await make(t.ids.next<'Checkout'>());
      await t.release.execute(system, { reservationId: fresh.reservationId, cause: 'cancelled' });

      const run = await t.prune.execute(system, {});

      expect(run).toMatchObject({ ok: true, value: { reservations: 1 } });
      expect(t.reservations.stored.has(old.reservationId)).toBe(false);
      expect(t.reservations.stored.has(fresh.reservationId)).toBe(true);
      // `kept` expired at read time but its status is still active: not terminal, not pruned.
      expect(t.reservations.stored.has(kept.reservationId)).toBe(true);
      expect(await t.prune.execute(customer(t), {})).toMatchObject({
        error: { code: 'access.denied' },
      });
    });

    it('purges rate counters 48 hours after their window started', async () => {
      const t = setUp();
      const w = world(t, [[high, high]]);
      await t.reserve.execute(customer(t), request(t, w.units));
      t.clock.advance(Temporal.Duration.from({ hours: 49 }));

      const run = await t.prune.execute(testCallContext(market, 'system'), {});

      expect(run).toMatchObject({ ok: true, value: { rateCounters: 2 } });
      expect(t.counters.rows.size).toBe(0);
    });
  });
});
