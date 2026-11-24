import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import { EMPTY_LEDGER_SUMS } from '../domain/ledger';
import type { MarketDay } from '../domain/facts';
import type { DayRange } from '../domain/period';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import type { LedgerKpiDependencies } from './ledger-kpi-flow';
import type { LedgerKpiReader, LedgerMatchFacts } from './ports/ledger-kpi-reader';
import { ViewMarketplaceNetRevenue } from './use-cases/view-marketplace-net-revenue.use-case';
import { ViewSellerNetEarnings } from './use-cases/view-seller-net-earnings.use-case';

// The net figure reads (dashboards v2, phase 1, PR 4) on both Market fixtures: only a platform
// admin reads net revenue and only the session's own seller its net earnings, both in the Market's
// currency and days, and neither figure is answered before the ledger readiness.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true as const }),
});
const NOW = Temporal.Instant.from('2026-11-22T14:30:00Z');

/** A week with one matched seller order a day: the minimum the readiness asks for. */
const busyWeek = (today: Temporal.PlainDate): LedgerMatchFacts => {
  const rows = Array.from({ length: 7 }, (_, n) => ({
    sellerOrderId: `so-${n}`,
    day: today.subtract({ days: n + 1 }).toString() as MarketDay,
  }));
  return { paid: rows, commission: rows, knownUnpaid: new Set() };
};

class FakeReader implements LedgerKpiReader {
  readonly calls: { currency: string; range: DayRange; sellerId: string | null }[] = [];
  finished = true;
  failedFacts = 0;
  match: LedgerMatchFacts = { paid: [], commission: [], knownUnpaid: new Set() };

  rangeSums(_market: unknown, currency: string, range: DayRange, sellerId: Id<'Seller'> | null) {
    this.calls.push({ currency, range, sellerId });
    return Promise.resolve({
      sums: {
        ...EMPTY_LEDGER_SUMS,
        commission: { amount: 1500n, baseAmount: 10_000n },
        'refund-commission': { amount: 150n, baseAmount: 1_000n },
        'cashback-seller': { amount: 200n, baseAmount: 0n },
      },
      refreshedAt: null,
    });
  }
  matchFacts() {
    return Promise.resolve(this.match);
  }
  backfillState() {
    return Promise.resolve({ finished: this.finished, failedFacts: this.failedFacts });
  }
}

describe.each(TEST_MARKETS)('the net figures in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
  const currency = zone.currencyOf(market);
  const sellerId = id<'Seller'>(0x5e11);
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id(0xa1),
      sessionId: id(0x10a1),
      sellerId: null,
    }),
  );
  const seller = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: id(0xb1),
      sessionId: id(0x10b1),
      sellerId,
    }),
  );
  const today = NOW.toZonedDateTimeISO(zone.zoneOf(market)).toPlainDate();
  const range = { from: today.subtract({ days: 6 }).toString(), to: today.toString() };
  let reader: FakeReader;
  let deps: LedgerKpiDependencies;

  beforeEach(() => {
    reader = new FakeReader();
    reader.match = busyWeek(today);
    deps = {
      unitOfWork: {
        run: (_market: unknown, work: () => Promise<unknown>) => work(),
      } as unknown as LedgerKpiDependencies['unitOfWork'],
      reader,
      zone,
      clock: new FixedClock(NOW),
    };
  });

  it('answers net revenue to a platform admin once ready, in the Market currency', async () => {
    const out = await new ViewMarketplaceNetRevenue(gate, deps).execute(admin, { range });
    if (!out.ok) throw new Error(out.error.code);
    expect(reader.calls).toEqual([{ currency, range, sellerId: null }]);
    expect(out.value.currency).toBe(currency);
    expect(out.value.readiness.ready).toBe(true);
    expect(out.value.netRevenue?.components.commission).toEqual({
      status: 'available',
      amount: 1350n,
    });
    // Only the commission has a source: the total is partial and carries no amount.
    expect(out.value.netRevenue?.total).toEqual({
      status: 'partial',
      missing: ['deliveryMargin', 'platformFundedDiscounts', 'platformFundedCashback', 'fleetFees'],
    });
  });

  it('withholds net revenue on a quiet week and after a backfill that refused rows', async () => {
    reader.match = { paid: [], commission: [], knownUnpaid: new Set() };
    const quiet = await new ViewMarketplaceNetRevenue(gate, deps).execute(admin, { range });
    if (!quiet.ok) throw new Error(quiet.error.code);
    expect(quiet.value.netRevenue).toBeNull();
    expect(quiet.value.readiness).toMatchObject({ ready: false, reason: 'insufficient-activity' });
    reader.match = busyWeek(today);
    reader.failedFacts = 2;
    const refused = await new ViewMarketplaceNetRevenue(gate, deps).execute(admin, { range });
    if (!refused.ok) throw new Error(refused.error.code);
    expect(refused.value.netRevenue).toBeNull();
    expect(refused.value.readiness).toMatchObject({
      ready: false,
      reason: 'backfill-refused-rows',
      backfillFailedFacts: 2,
    });
    const early = await new ViewSellerNetEarnings(gate, deps).execute(seller, { range });
    expect(early.ok && early.value).toMatchObject({ ready: false, earnings: null });
  });

  it('refuses net revenue to an admin acting as a seller and to a customer', async () => {
    const actingAs = {
      ...admin,
      actor: { ...admin.actor, actingAs: { adminAccountId: id(0xa1) } },
    } as never;
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: id(0xc1),
        sessionId: id(0x10c1),
        sellerId: null,
      }),
    );
    for (const context of [actingAs, customer]) {
      expect(
        await new ViewMarketplaceNetRevenue(gate, deps).execute(context, { range }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    }
    expect(reader.calls).toEqual([]);
  });

  it('withholds net revenue until a week of matching ledger', async () => {
    reader.match = {
      paid: [{ sellerOrderId: 'x', day: today.subtract({ days: 2 }).toString() as never }],
      commission: [],
      knownUnpaid: new Set(),
    };
    const out = await new ViewMarketplaceNetRevenue(gate, deps).execute(admin, { range });
    if (!out.ok) throw new Error(out.error.code);
    expect(out.value.netRevenue).toBeNull();
    expect(out.value.readiness).toMatchObject({ ready: false, reason: 'days-not-matching' });
    reader.match = busyWeek(today);
    reader.finished = false;
    const running = await new ViewMarketplaceNetRevenue(gate, deps).execute(admin, { range });
    expect(running.ok && running.value.netRevenue).toBeNull();
  });

  it('refuses net revenue to a seller and a bad range to anyone', async () => {
    expect(
      await new ViewMarketplaceNetRevenue(gate, deps).execute(seller, { range }),
    ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    const future = { from: range.from, to: today.add({ days: 1 }).toString() };
    expect(
      await new ViewMarketplaceNetRevenue(gate, deps).execute(admin, { range: future }),
    ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(reader.calls).toEqual([]);
  });

  it("answers the session seller's own net earnings only, never a seller from input", async () => {
    const input = { range, sellerId: id(0x999) } as never;
    const out = await new ViewSellerNetEarnings(gate, deps).execute(seller, input);
    if (!out.ok) throw new Error(out.error.code);
    expect(reader.calls).toEqual([{ currency, range, sellerId }]);
    // 10000 - 1000 - (1500 - 150) - 200.
    expect(out.value.earnings?.netEarnings).toBe(7450n);
    expect(out.value).not.toHaveProperty('readiness');
    expect(await new ViewSellerNetEarnings(gate, deps).execute(admin, { range })).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    reader.finished = false;
    const early = await new ViewSellerNetEarnings(gate, deps).execute(seller, { range });
    expect(early.ok && early.value).toMatchObject({ ready: false, earnings: null });
  });
});
