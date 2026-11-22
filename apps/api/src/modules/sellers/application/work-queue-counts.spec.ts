import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../test/support/test-config';
import type { AccessDeclaration } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { WorkQueueCountDependencies } from '../../../platform/work-queue/count-work-queue';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import { SELLERS_SELLER_VIEW } from '../contracts/permissions';
import type { SellersWorkQueueCountReader } from './ports/work-queue-count.reader';
import { CountSellerApplications } from './use-cases/count-seller-applications.use-case';
import { CountUnhealthySellers } from './use-cases/count-unhealthy-sellers.use-case';

// The sellers counts of the dashboard's work queue (dashboards upgrade, phase 1), on both Market
// fixtures: each use case's key, platform admins only, the query's times passed to the reader in
// the caller's Market, and `access.unavailable` once the dashboard stopped waiting or the store
// fails.

type Deps = WorkQueueCountDependencies<SellersWorkQueueCountReader>;

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 48 });
const COUNT = { count: 3, overdue: 1, oldestAt: NOW.subtract({ hours: 50 }) };

let declarations: AccessDeclaration[];
let reads: { method: string; market: MarketContext; times: Temporal.Instant[] }[];
let failing: boolean;

const gate = createUseCaseGate(markets, {
  check: (_context, declaration) => {
    declarations.push(declaration);
    return Promise.resolve({ allowed: true as const });
  },
});
const unitOfWork = {
  run: (_market: MarketContext, work: () => Promise<unknown>, options?: { readOnly?: boolean }) => {
    if (options?.readOnly !== true) throw new Error('expected a read-only unit');
    return work();
  },
} as unknown as UnitOfWork;
const counts: SellersWorkQueueCountReader = {
  applications: (m, now, staleBefore) => {
    reads.push({ method: 'applications', market: m, times: [now, staleBefore] });
    return failing ? Promise.reject(new Error('down')) : Promise.resolve(COUNT);
  },
  unhealthySellers: (m, now, staleBefore) => {
    reads.push({ method: 'unhealthySellers', market: m, times: [now, staleBefore] });
    return failing ? Promise.reject(new Error('down')) : Promise.resolve(COUNT);
  },
};
const USE_CASES = [
  {
    method: 'applications',
    make: (deps: Deps) => new CountSellerApplications(gate, deps),
    key: SELLERS_SELLER_VIEW.key,
  },
  {
    method: 'unhealthySellers',
    make: (deps: Deps) => new CountUnhealthySellers(gate, deps),
    key: SELLERS_SELLER_VIEW.key,
  },
];

beforeEach(() => {
  declarations = [];
  reads = [];
  failing = false;
});

describe.each(TEST_MARKETS)('sellers work-queue counts in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const actor = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1),
        sessionId: id(0xa2),
        sellerId: population === 'seller' ? id(0xa3) : null,
      }),
    );
  /** The admin acting as a seller (Login as Seller): never a platform-wide count. */
  const actingAs = (): CallContext => {
    const own = actor('admin');
    return Object.assign(Object.create(Object.getPrototypeOf(own) as object) as object, own, {
      actor: { ...own.actor, actingAs: { sellerId: id(0xa4) } },
    });
  };
  const query = (signal: AbortSignal = new AbortController().signal): WorkQueueCountQuery => ({
    now: NOW,
    staleBefore: STALE,
    signal,
  });

  describe.each(USE_CASES)('$method', ({ method, make, key }) => {
    const useCase = make({ unitOfWork, counts });

    it("counts behind its key, with the times of the query, in the caller's Market", async () => {
      expect(await useCase.execute(actor('admin'), query())).toEqual(ok(COUNT));
      expect(declarations.map((d) => d.rule)).toEqual([{ kind: 'permissions', allOf: [key] }]);
      expect(reads).toEqual([{ method, market, times: [NOW, STALE] }]);
    });

    it('refuses a seller and an acting-as session, before any read', async () => {
      expect(await useCase.execute(actor('seller'), query())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await useCase.execute(actingAs(), query())).toEqual(err({ code: 'access.denied' }));
      expect(reads).toHaveLength(0);
    });

    it('answers access.unavailable once the dashboard stopped waiting, or the store fails', async () => {
      const stopped = new AbortController();
      stopped.abort();
      expect(await useCase.execute(actor('admin'), query(stopped.signal))).toEqual(
        err({ code: 'access.unavailable' }),
      );
      expect(reads).toHaveLength(0);
      failing = true;
      expect(await useCase.execute(actor('admin'), query())).toEqual(
        err({ code: 'access.unavailable' }),
      );
    });
  });
});
