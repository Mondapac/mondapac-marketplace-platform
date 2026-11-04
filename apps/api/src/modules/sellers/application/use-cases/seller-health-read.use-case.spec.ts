import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerFile } from '../../domain/seller-file';
import {
  computeSellerHealth,
  type SellerHealthInput,
  type SellerHealthSettings,
} from '../../domain/seller-health';
import { DefaultSellerHealthPolicy } from '../../infrastructure/default-seller-health-policy';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerHealthSnapshot, SellerHealthStore } from '../ports/seller-health.store';
import { SELLER_HEALTH_TREND_DAYS, SellerHealthRead } from './seller-health-read.use-case';

// `sellers.seller-health-read` in memory, on both Market fixtures: the card and trend of a
// measured seller, the empty answer for an unmeasured one, the alike refusal for unknown and
// other-Market ids, and the gate. PostgreSQL is covered by the store's db-spec and the e2e.

const NOW = Temporal.Instant.from('2026-11-10T12:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const denyAll: AuthorisationCheck = {
  check: () => Promise.resolve({ allowed: false, denial: { code: 'access.denied' } }),
};

const INPUT: SellerHealthInput = {
  orders: 40,
  sellerCancellations: { count: 0, base: 0 },
  lateReady: { count: 2, base: 40 },
  lostDisputes: { count: 0, base: 40 },
  customerRating: { count: 8, averageHundredths: 460 },
  reports: null,
};

describe.each(['AU', 'ZZ'] as const)('sellers.seller-health-read (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);
  const policy = new DefaultSellerHealthPolicy();
  let thresholds: SellerHealthSettings;
  let seller: Id<'Seller'>;
  let snaps: SellerHealthSnapshot[];
  let asked: { from: string; to: string }[];
  let units: { readOnly: boolean }[];
  let known: Set<string>;

  const snapshotOn = (day: string, input: SellerHealthInput = INPUT): SellerHealthSnapshot => ({
    day: Temporal.PlainDate.from(day),
    health: computeSellerHealth(input, thresholds),
    inputs: input,
    computedAt: NOW,
  });

  const useCase = (authorisation: AuthorisationCheck = admitAll) => {
    const files = {
      findById: (m: MarketContext, id: Id<'Seller'>) =>
        Promise.resolve(m.marketId === code && known.has(id) ? ({} as SellerFile) : null),
    } as unknown as SellerFileRepository;
    const healthStore = {
      snapshots: (
        m: MarketContext,
        id: Id<'Seller'>,
        from: Temporal.PlainDate,
        to: Temporal.PlainDate,
      ) => {
        asked.push({ from: from.toString(), to: to.toString() });
        return Promise.resolve(
          m.marketId === code && id === seller
            ? snaps.filter(
                (s) =>
                  Temporal.PlainDate.compare(s.day, from) >= 0 &&
                  Temporal.PlainDate.compare(s.day, to) <= 0,
              )
            : [],
        );
      },
    } as unknown as SellerHealthStore;
    const unitOfWork: UnitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>, opts?: unknown) => {
        units.push({ readOnly: (opts as { readOnly?: boolean } | undefined)?.readOnly === true });
        return work();
      },
      runOnce: noRunOnce,
    };
    return new SellerHealthRead(createUseCaseGate(markets, authorisation), {
      unitOfWork,
      files,
      healthStore,
      clock,
    });
  };
  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );

  beforeAll(async () => {
    thresholds = (await policy.settings()).thresholds;
  });

  beforeEach(() => {
    seller = ids.next<'Seller'>();
    known = new Set([seller]);
    snaps = [];
    asked = [];
    units = [];
  });

  it('returns the latest card and the trend, oldest first, in one read-only unit', async () => {
    snaps = [snapshotOn('2026-11-08'), snapshotOn('2026-11-09'), snapshotOn('2026-11-10')];
    const result = await useCase().execute(admin(), { sellerId: seller });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sellerId).toBe(seller);
    expect(result.value.current?.day).toBe('2026-11-10');
    expect(result.value.current?.kind).toBe('scored');
    expect(result.value.current?.orders).toBe(40);
    expect(result.value.current?.metrics).toHaveLength(5);
    expect(result.value.trend.map((p) => p.day)).toEqual([
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ]);
    expect(units).toEqual([{ readOnly: true }]);
  });

  it('reads the last 90 days up to tomorrow in UTC', async () => {
    await useCase().execute(admin(), { sellerId: seller });
    expect(SELLER_HEALTH_TREND_DAYS).toBe(90);
    expect(asked).toEqual([{ from: '2026-08-13', to: '2026-11-11' }]);
  });

  it('answers current null and an empty trend for a seller no night has measured', async () => {
    const result = await useCase().execute(admin(), { sellerId: seller });
    expect(result).toEqual({ ok: true, value: { sellerId: seller, current: null, trend: [] } });
  });

  it('shows a New seller without a score', async () => {
    snaps = [snapshotOn('2026-11-10', { ...INPUT, orders: 3 })];
    const result = await useCase().execute(admin(), { sellerId: seller });
    expect(result.ok && result.value.current).toMatchObject({
      kind: 'new',
      band: null,
      score: null,
      lowestMetric: null,
      orders: 3,
    });
  });

  it('answers file.not-found alike for an unknown id, a malformed id and a seller of another Market', async () => {
    const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const foreign = testCallContext(
      otherMarket,
      testAuthenticatedActor(otherMarket, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    const answers = [
      await useCase().execute(admin(), { sellerId: ids.next<'Seller'>() }),
      await useCase().execute(admin(), { sellerId: 'not-an-id' }),
      await useCase().execute(admin(), { sellerId: 42 as never }),
      await useCase().execute(foreign, { sellerId: seller }),
    ].map((r) => JSON.stringify(r));
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!)).toEqual({ ok: false, error: { code: 'file.not-found' } });
  });

  it('refuses an actor without the permission and reads nothing', async () => {
    snaps = [snapshotOn('2026-11-10')];
    const result = await useCase(denyAll).execute(admin(), { sellerId: seller });
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(asked).toEqual([]);
    expect(units).toEqual([]);
  });
});
