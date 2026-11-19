import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
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
import {
  computeSellerHealth,
  type SellerHealthInput,
  type SellerHealthSettings,
} from '../../domain/seller-health';
import { DefaultSellerHealthPolicy } from '../../infrastructure/default-seller-health-policy';
import type {
  SellerHealthRequest,
  SellerHealthRequestSource,
  SellerHealthRequestStore,
} from '../ports/seller-health-request.store';
import type { SellerHealthRoster } from '../ports/seller-health-roster';
import type { SellerHealthSnapshot, SellerHealthStore } from '../ports/seller-health.store';
import { SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS } from './refresh-own-seller-health.use-case';
import { ReadOwnSellerHealth } from './read-own-seller-health.use-case';

// `sellers.read-own-seller-health` in memory, on both Market fixtures: the acting seller's own
// card and trend, the empty answer before any night ran, the refresh state (pending, cooldown
// seconds left, admin requests never lock the seller), only a seller session, and the gate.

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

describe.each(['AU', 'ZZ'] as const)('sellers.read-own-seller-health (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);
  const mine = ids.next<'Seller'>();
  const other = ids.next<'Seller'>();
  const policy = new DefaultSellerHealthPolicy();
  let thresholds: SellerHealthSettings;
  let snaps: Map<string, SellerHealthSnapshot[]>;
  let requests: SellerHealthRequest[];
  let units: { readOnly: boolean }[];
  let unitFails: boolean;

  const snapshotOn = (day: string): SellerHealthSnapshot => ({
    day: Temporal.PlainDate.from(day),
    health: computeSellerHealth(INPUT, thresholds),
    inputs: INPUT,
    computedAt: NOW,
  });

  const useCase = (authorisation: AuthorisationCheck = admitAll) => {
    const unitOfWork: UnitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>, opts?: unknown) => {
        units.push({ readOnly: (opts as { readOnly?: boolean } | undefined)?.readOnly === true });
        return unitFails ? Promise.reject(new Error('db down')) : work();
      },
      runOnce: noRunOnce,
    };
    const healthRoster: SellerHealthRoster = {
      page: () => Promise.resolve([]),
      one: (_m, seller) =>
        Promise.resolve(seller === mine ? { sellerId: seller, zone: 'UTC' } : null),
    };
    const healthStore = {
      snapshots: (_m: MarketContext, id: Id<'Seller'>) => Promise.resolve(snaps.get(id) ?? []),
    } as unknown as SellerHealthStore;
    const healthRequests = {
      latest: (_m: MarketContext, seller: Id<'Seller'>, source?: SellerHealthRequestSource) =>
        Promise.resolve(
          [...requests]
            .reverse()
            .find((r) => r.sellerId === seller && (source === undefined || r.source === source)) ??
            null,
        ),
    } as unknown as SellerHealthRequestStore;
    return new ReadOwnSellerHealth(createUseCaseGate(markets, authorisation), {
      unitOfWork,
      healthRoster,
      healthStore,
      healthRequests,
      clock,
    });
  };

  const sellerContext = (sellerId: Id<'Seller'> = mine) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
  const requestOf = (
    source: SellerHealthRequestSource,
    at: Temporal.Instant,
    status: 'pending' | 'done',
  ): SellerHealthRequest => ({
    id: ids.next(),
    sellerId: mine,
    source,
    requestedAt: at,
    status,
  });

  beforeEach(async () => {
    thresholds = (await policy.settings()).thresholds;
    clock.set(NOW);
    snaps = new Map();
    requests = [];
    units = [];
    unitFails = false;
  });

  it("answers the acting seller's own card and trend, in one read-only unit", async () => {
    snaps.set(mine, [snapshotOn('2026-11-08'), snapshotOn('2026-11-09')]);
    snaps.set(other, [snapshotOn('2026-11-09')]);
    const result = await useCase().execute(sellerContext(), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.current?.day).toBe('2026-11-09');
    expect(result.value.trend.map((p) => p.day)).toEqual(['2026-11-08', '2026-11-09']);
    expect(units).toEqual([{ readOnly: true }]);
  });

  it('answers an empty card before any night measured the seller', async () => {
    const result = await useCase().execute(sellerContext(), {});
    expect(result).toEqual({
      ok: true,
      value: {
        current: null,
        trend: [],
        refresh: { pending: false, retryAfterSeconds: 0 },
      },
    });
  });

  it('shows the cooldown seconds left after the seller own click, and a pending request', async () => {
    requests = [requestOf('seller', NOW.subtract({ minutes: 5 }), 'pending')];
    const result = await useCase().execute(sellerContext(), {});
    expect(result.ok && result.value.refresh).toEqual({
      pending: true,
      retryAfterSeconds: SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS - 300,
    });
  });

  it('lets the seller click again once the cooldown has passed', async () => {
    requests = [requestOf('seller', NOW.subtract({ minutes: 20 }), 'done')];
    const result = await useCase().execute(sellerContext(), {});
    expect(result.ok && result.value.refresh).toEqual({ pending: false, retryAfterSeconds: 0 });
  });

  it('never lets an admin request lock the seller, but shows it is on its way', async () => {
    requests = [requestOf('admin', NOW.subtract({ minutes: 1 }), 'pending')];
    const result = await useCase().execute(sellerContext(), {});
    expect(result.ok && result.value.refresh).toEqual({ pending: true, retryAfterSeconds: 0 });
  });

  it('answers file.not-found for a seller with no file in this Market', async () => {
    const result = await useCase().execute(sellerContext(other), {});
    expect(result).toEqual({ ok: false, error: { code: 'file.not-found' } });
  });

  it('refuses an admin session', async () => {
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    const result = await useCase().execute(admin, {});
    expect(result.ok).toBe(false);
  });

  it('refuses an actor the gate does not admit', async () => {
    const result = await useCase(denyAll).execute(sellerContext(), {});
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(units).toEqual([]);
  });

  it('answers sellers.unavailable when the unit fails', async () => {
    unitFails = true;
    const result = await useCase().execute(sellerContext(), {});
    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });
});
