import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { openGate } from '../../../../../test/support/system-only-denial';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { MarketZone } from '../ports/market-zone';
import type { SellerKpiReader } from '../ports/seller-kpi-reader';
import { ViewSellerKpis } from './view-seller-kpis.use-case';

// The seller KPI read on both Market fixtures: the seller is the session's own and the only one
// ever read, other populations and bad periods are refused before any read, the days are the
// Market's, and the read is one read-only unit.

const id = (n: number): Id<'Seller'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Seller'>;
};

describe.each(TEST_MARKETS)('ViewSellerKpis in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const OWN = id(0xa3);
  const asked: { seller: Id<'Seller'>; currency: string; from: string; to: string }[] = [];
  const reads: boolean[] = [];
  const reader: SellerKpiReader = {
    read: (_m, seller, currency, current) => {
      asked.push({ seller, currency, from: current.from, to: current.to });
      return Promise.resolve({ daily: [], categories: [] });
    },
  };
  const unitOfWork = {
    run: (_m: unknown, work: () => Promise<unknown>, options?: { readOnly?: boolean }) => {
      reads.push(options?.readOnly === true);
      return work();
    },
  } as unknown as UnitOfWork;
  // 2026-11-21T23:30Z is already the 22nd east of UTC+0:30, and the 21st in Pacific zones: the
  // zone decides the day.
  const zone = (name: string): MarketZone => ({ zoneOf: () => name, currencyOf: () => 'XXX' });
  const build = (zoneName = 'Australia/Brisbane') =>
    new ViewSellerKpis(openGate(), {
      unitOfWork,
      reader,
      zone: zone(zoneName),
      clock: new FixedClock(Temporal.Instant.from('2026-11-21T23:30:00Z')),
    });
  const as = (population: 'seller' | 'customer' | 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1) as never,
        sessionId: id(0xa2) as never,
        sellerId: population === 'seller' ? OWN : null,
      }),
    );

  beforeEach(() => {
    asked.length = 0;
    reads.length = 0;
  });

  it("reads only the session's seller, in the Market's currency and days, in a read-only unit", async () => {
    const result = await build().execute(as('seller'), { period: '7d' });
    expect(result.ok).toBe(true);
    expect(asked).toEqual([{ seller: OWN, currency: 'XXX', from: '2026-11-16', to: '2026-11-22' }]);
    expect(reads).toEqual([true]);
  });

  it('counts the day in the Market zone, not UTC', async () => {
    await build('Pacific/Honolulu').execute(as('seller'), { period: 'today' });
    expect(asked[0]).toMatchObject({ from: '2026-11-21', to: '2026-11-21' });
  });

  it('defaults to 30 days and refuses an unknown period before any read', async () => {
    await build().execute(as('seller'), {});
    expect(asked[0]).toMatchObject({ from: '2026-10-24', to: '2026-11-22' });
    asked.length = 0;
    const bad = await build().execute(as('seller'), { period: 'year' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(asked).toEqual([]);
  });

  it('refuses an array period and answers access.unavailable when the store throws', async () => {
    const array = await build().execute(as('seller'), { period: ['7d', '30d'] });
    expect(array).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    const failing = new ViewSellerKpis(openGate(), {
      unitOfWork: {
        run: () => Promise.reject(new Error('select secret')),
      } as unknown as UnitOfWork,
      reader,
      zone: zone('Australia/Brisbane'),
      clock: new FixedClock(Temporal.Instant.from('2026-11-21T23:30:00Z')),
    });
    const result = await failing.execute(as('seller'), { period: '7d' });
    expect(result).toMatchObject({ ok: false, error: { code: 'access.unavailable' } });
  });

  it.each(['customer', 'admin'] as const)('refuses a %s session before any read', async (who) => {
    const result = await build().execute(as(who), { period: '7d' });
    expect(result).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(asked).toEqual([]);
  });
});
