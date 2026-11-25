import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  Money,
  Result,
} from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import { emptyDay, type DayTotals } from '../domain/admin-kpi';
import { REPORTING_AUDIT_ACTIONS } from '../domain/audit';
import type { MarketDay } from '../domain/facts';
import type { CalendarMonth } from '../domain/month-forecast';
import type { DayRange } from '../domain/period';
import type { SellerKpiDayRow } from '../domain/seller-kpis';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import type { AdminKpiReader, DailyTotals } from './ports/admin-kpi-reader';
import type {
  SellerGoalChange,
  SellerGoalStore,
  SellerMonthlyGoal,
} from './ports/seller-goal-store';
import type { SellerKpiReader } from './ports/seller-kpi-reader';
import { isActingAsSession } from './acting-as';
import { SetSellerMonthlyGoal } from './use-cases/set-seller-monthly-goal.use-case';
import { ViewMarketplaceMonthlyTarget } from './use-cases/view-marketplace-monthly-target.use-case';
import {
  ViewSellerMonthlyGoal,
  type SellerGoalDependencies,
} from './use-cases/view-seller-monthly-goal.use-case';

// The monthly target and the seller goal (dashboards v2 phase 2) on both Market fixtures: the
// month and its days are the MARKET's, the revenue basis is the KPI one (goods with tax of paid
// orders), money is the Market's currency only, the admin read is a platform admin's only, and
// the goal is always the session seller's.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true as const }),
});
// 15 Nov 2026 03:00 UTC: the 15th in Brisbane (13:00) and in Tokyo (12:00).
const NOW = Temporal.Instant.from('2026-11-15T03:00:00Z');
const SELLER = id<'Seller'>(0x5e11);
const OTHER_SELLER = id<'Seller'>(0x5e12);
const ACTIONS = new Set<string>(REPORTING_AUDIT_ACTIONS.map((a) => a.action));

const day = (text: string): MarketDay => text as MarketDay;

class FakeAdminReader implements Pick<AdminKpiReader, 'dailyTotals'> {
  rows: DayTotals[] = [];
  readonly calls: { currency: string; range: DayRange; marketId: string }[] = [];
  failing = false;
  dailyTotals(market: MarketContext, currency: string, range: DayRange): Promise<DailyTotals> {
    if (this.failing) return Promise.reject(new TypeError('down'));
    this.calls.push({ currency, range, marketId: market.marketId });
    return Promise.resolve({
      days: this.rows.filter((row) => row.day >= range.from && row.day <= range.to),
      refreshedAt: null,
    });
  }
}

class FakeSellerReader implements SellerKpiReader {
  rows: { sellerId: string; row: SellerKpiDayRow }[] = [];
  readonly calls: { sellerId: string; currency: string; range: DayRange }[] = [];
  read(): never {
    throw new Error('not used');
  }
  daily(_market: MarketContext, sellerId: Id<'Seller'>, currency: string, range: DayRange) {
    this.calls.push({ sellerId, currency, range });
    return Promise.resolve(
      this.rows
        .filter(
          (entry) =>
            entry.sellerId === sellerId &&
            entry.row.marketDay >= range.from &&
            entry.row.marketDay <= range.to,
        )
        .map((entry) => entry.row),
    );
  }
}

/** Keyed by Market, seller and month, as the table is. */
class MemoryGoals implements SellerGoalStore {
  readonly rows = new Map<string, SellerMonthlyGoal>();
  private key = (market: MarketContext, sellerId: string, month: string) =>
    `${market.marketId}/${sellerId}/${month}`;
  find(market: MarketContext, sellerId: Id<'Seller'>, month: CalendarMonth) {
    return Promise.resolve(this.rows.get(this.key(market, sellerId, month)) ?? null);
  }
  save(market: MarketContext, change: SellerGoalChange) {
    const key = this.key(market, change.sellerId, change.month);
    if ((this.rows.get(key)?.version ?? 0) !== change.version - 1) return Promise.resolve(false);
    this.rows.set(key, {
      month: change.month,
      goal: change.goal,
      version: change.version,
      updatedAt: change.changedAt,
    });
    return Promise.resolve(true);
  }
}

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

const sellerRow = (marketDay: string, goodsAmount: bigint): SellerKpiDayRow => ({
  marketDay: day(marketDay),
  ordersPaid: 1,
  goodsAmount,
  goodsTax: 0n,
  units: 1,
  ordersCancelled: 0,
  ordersShipped: 0,
  ordersShippedOnTime: 0,
  refunds: 0,
  refundGoodsAmount: -1_000n,
  refundGoodsTax: 0n,
  refundShippingAmount: 0n,
  refundShippingTax: 0n,
  refreshedAt: NOW,
});

describe.each(TEST_MARKETS)('the monthly target and seller goal in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
  const currency = zone.currencyOf(market);
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id(0xa1),
      sessionId: id(0x10a1),
      sellerId: null,
    }),
  );
  const sellerOf = (sellerId: Id<'Seller'>, accountId = 0xb1) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id(accountId),
        sessionId: id(0x10b1),
        sellerId,
      }),
    );
  const seller = sellerOf(SELLER);
  const actingAs = Object.assign(
    Object.create(Object.getPrototypeOf(admin) as object) as object,
    admin,
    { actor: { ...admin.actor, actingAs: { sellerId: SELLER } } },
  ) as typeof admin;

  describe('the marketplace monthly target', () => {
    let reader: FakeAdminReader;
    let target: Result<Money | null, AccessDenied>;
    const build = () =>
      new ViewMarketplaceMonthlyTarget(gate, {
        unitOfWork: new FakeUnitOfWork(),
        reader: reader as unknown as AdminKpiReader,
        zone,
        clock: new FixedClock(NOW),
        targets: { marketTarget: () => Promise.resolve(target) },
      });

    beforeEach(() => {
      reader = new FakeAdminReader();
      target = ok({ amount: 30_000n, currency });
      reader.rows = [
        // Last month (whole), the month to date, and one day after today that is never read.
        { ...emptyDay(day('2026-10-01')), goodsAmount: 20_000n, refundGoodsAmount: -5_000n },
        { ...emptyDay(day('2026-10-31')), goodsAmount: 1_000n },
        { ...emptyDay(day('2026-11-01')), goodsAmount: 9_000n, refundGoodsAmount: -2_000n },
        { ...emptyDay(day('2026-11-14')), goodsAmount: 5_000n },
        { ...emptyDay(day('2026-09-30')), goodsAmount: 99_000n },
      ];
    });

    it('reads the Market month to date and the whole month before in its currency, with the forecast and pace', async () => {
      const out = await build().execute(admin, {});
      if (!out.ok) throw new Error('expected an answer');
      expect(reader.calls).toEqual([
        { currency, range: { from: '2026-11-01', to: '2026-11-15' }, marketId: code },
        { currency, range: { from: '2026-10-01', to: '2026-10-31' }, marketId: code },
      ]);
      expect(out.value).toMatchObject({
        timezone: zone.zoneOf(market),
        currency,
        figures: {
          month: '2026-11',
          lastMonth: '2026-10',
          dayOfMonth: 15,
          daysLeft: 16,
          // GMV: refunds never lower it.
          monthToDate: 14_000n,
          lastMonthTotal: 21_000n,
          target: 30_000n,
          progressBp: 4667,
          forecast: { status: 'estimate' },
        },
      });
      const { forecast } = out.value.figures;
      // A little over 14 days elapsed of 30: a bit under 30,000.
      expect(forecast.status === 'estimate' && forecast.amount).toBeGreaterThan(28_000n);
      expect(forecast.status === 'estimate' && forecast.amount).toBeLessThan(30_000n);
    });

    it('answers no target when none is set or it is in another currency', async () => {
      target = ok(null);
      const none = await build().execute(admin, {});
      expect(none.ok && none.value.figures.target).toBeNull();
      target = ok({ amount: 30_000n, currency: currency === 'AUD' ? 'JPY' : 'AUD' });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const other = await build().execute(admin, {});
        expect(other.ok && other.value.figures).toMatchObject({ target: null, paceBp: null });
      } finally {
        warn.mockRestore();
      }
    });

    it('refuses a seller and an acting-as admin, passes the owner refusal on, and fails closed', async () => {
      expect(await build().execute(seller, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await build().execute(actingAs, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(reader.calls).toHaveLength(0);
      target = err({ code: 'access.denied' });
      expect(await build().execute(admin, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      target = err({ code: 'access.unavailable' });
      expect(await build().execute(admin, {})).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      target = ok(null);
      reader.failing = true;
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        expect(await build().execute(admin, {})).toEqual({
          ok: false,
          error: { code: 'access.unavailable' },
        });
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('the seller monthly goal', () => {
    let reader: FakeSellerReader;
    let goals: MemoryGoals;
    let audit: RecordingAudit;
    let deps: SellerGoalDependencies;
    const view = (context = seller) => new ViewSellerMonthlyGoal(gate, deps).execute(context, {});
    const set = (input: Record<string, unknown>, context = seller) =>
      new SetSellerMonthlyGoal(gate, { ...deps, audit }).execute(context, input);

    beforeEach(() => {
      reader = new FakeSellerReader();
      goals = new MemoryGoals();
      audit = new RecordingAudit();
      deps = { unitOfWork: new FakeUnitOfWork(), reader, goals, zone, clock: new FixedClock(NOW) };
      reader.rows = [
        { sellerId: SELLER, row: sellerRow('2026-11-02', 4_000n) },
        { sellerId: SELLER, row: sellerRow('2026-10-20', 6_000n) },
        { sellerId: OTHER_SELLER, row: sellerRow('2026-11-02', 50_000n) },
      ];
    });

    it('shows the session seller month without a goal, then with the goal it sets', async () => {
      const before = await view();
      expect(before.ok && before.value).toMatchObject({
        currency,
        version: 0,
        figures: { monthToDate: 4_000n, lastMonthTotal: 6_000n, target: null },
      });
      expect(
        reader.calls.every((call) => call.sellerId === SELLER && call.currency === currency),
      ).toBe(true);
      const saved = await set({ month: '2026-11', amount: '8000', currency, expectedVersion: 0 });
      expect(saved).toEqual({
        ok: true,
        value: { month: '2026-11', goal: { amount: 8_000n, currency }, version: 1, updatedAt: NOW },
      });
      const after = await view();
      expect(after.ok && after.value).toMatchObject({
        version: 1,
        figures: { target: 8_000n, progressBp: 5000, toGo: 4_000n, perDayToGo: 250n },
      });
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: 'reporting.seller-goal.changed',
          targetId: SELLER,
          before: { goal: null },
          after: {
            monthStart: Temporal.PlainDate.from('2026-11-01')
              .toZonedDateTime({ timeZone: zone.zoneOf(market) })
              .toInstant(),
            goal: { amount: 8_000n, currency },
            version: 1,
          },
        }),
      ]);
      // Another seller of the Market, and the same seller in another Market, see no goal.
      const other = await view(sellerOf(OTHER_SELLER, 0xb2));
      expect(other.ok && other.value.figures).toMatchObject({ target: null, monthToDate: 50_000n });
      const elsewhere = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', PLATFORM_TENANT_ID);
      expect(await goals.find(elsewhere, SELLER, '2026-11' as CalendarMonth)).toBeNull();
    });

    it('changes the goal from the version seen, ignores a repeat, and refuses a stale version', async () => {
      await set({ month: '2026-12', amount: '8000', currency, expectedVersion: 0 });
      const repeat = await set({ month: '2026-12', amount: '8000', currency, expectedVersion: 1 });
      expect(repeat.ok && repeat.value.version).toBe(1);
      expect(audit.entries).toHaveLength(1);
      const changed = await set({ month: '2026-12', amount: '9000', currency, expectedVersion: 1 });
      expect(changed.ok && changed.value.version).toBe(2);
      expect(audit.entries[1]).toMatchObject({
        before: { goal: { amount: 8_000n, currency } },
        after: { goal: { amount: 9_000n, currency }, version: 2 },
      });
      const stale = await set({ month: '2026-12', amount: '1', currency, expectedVersion: 1 });
      expect(stale).toEqual({ ok: false, error: { code: 'reporting.seller-goal-conflict' } });
      // The December goal is not November's.
      const november = await view();
      expect(november.ok && november.value.figures.target).toBeNull();
    });

    it.each([
      [{ month: '2026-10' }, 'month', 'range'],
      [{ month: '2027-12' }, 'month', 'range'],
      [{ month: '2026-11-01' }, 'month', 'format'],
      [{ amount: '0' }, 'amount', 'value'],
      [{ amount: '-1' }, 'amount', 'value'],
      [{ amount: 8000 }, 'amount', 'value'],
      [{ amount: '1234567890123456' }, 'amount', 'value'],
      [{ currency: 'OTHER' }, 'currency', 'value'],
      [{ expectedVersion: -1 }, 'expectedVersion', 'type'],
      [{ expectedVersion: '0' }, 'expectedVersion', 'type'],
    ])('refuses %j', async (change, path, fieldCode) => {
      const input = {
        month: '2026-11',
        amount: '8000',
        currency,
        expectedVersion: 0,
        ...change,
        ...('currency' in change ? { currency: currency === 'AUD' ? 'JPY' : 'AUD' } : {}),
      };
      expect(await set(input)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code: fieldCode }] },
      });
      expect(goals.rows.size).toBe(0);
    });

    it('accepts the twelfth month ahead, and works for the session seller only', async () => {
      expect((await set({ month: '2027-11', amount: '1', currency, expectedVersion: 0 })).ok).toBe(
        true,
      );
      // An admin acting as themselves has no session seller.
      expect(
        await set({ month: '2026-11', amount: '1', currency, expectedVersion: 0 }, admin),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await view(admin)).toEqual({ ok: false, error: { code: 'access.denied' } });
      // A sellerId in the input is never read: the goal lands on the session's seller.
      await set({
        month: '2026-11',
        amount: '5',
        currency,
        expectedVersion: 0,
        sellerId: OTHER_SELLER,
      });
      expect(await goals.find(market, OTHER_SELLER, '2026-11' as CalendarMonth)).toBeNull();
      expect((await goals.find(market, SELLER, '2026-11' as CalendarMonth))?.goal.amount).toBe(5n);
    });

    it('refuses a goal write in an acting-as (Login as Seller) session and writes nothing', async () => {
      // As the catalog tag writes test it: the seller context with the reserved marker (SEL-08).
      const acting = {
        ...seller,
        actor: { ...seller.actor, actingAs: { adminAccountId: id(0xa1) } },
      } as unknown as CallContext;
      expect(isActingAsSession(acting.actor)).toBe(true);
      expect(isActingAsSession(seller.actor)).toBe(false);
      expect(
        await set({ month: '2026-11', amount: '8000', currency, expectedVersion: 0 }, acting),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(goals.rows.size).toBe(0);
      expect(audit.entries).toHaveLength(0);
    });

    it('fails closed when the store fails', async () => {
      reader.daily = () => Promise.reject(new TypeError('down'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        expect(await view()).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      } finally {
        warn.mockRestore();
      }
    });
  });
});
