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
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../contracts/permissions';
import type { CommissionPayoutsWorkQueueCountReader } from './ports/work-queue-count.reader';
import { CountSellerDisputesNeedingReply } from './use-cases/count-seller-disputes-needing-reply.use-case';
import { CountSellerPayoutHolds } from './use-cases/count-seller-payout-holds.use-case';

// The commission-payouts seller tasks of the dashboard (dashboards upgrade, phase 1, PR 6), on both Market
// fixtures: each use case's key and seller-state answer, the session's seller passed to the
// reader (never another), a customer and an admin acting as themselves refused before any read,
// and `access.unavailable` once the dashboard stopped waiting or the store fails.

type Deps = WorkQueueCountDependencies<CommissionPayoutsWorkQueueCountReader>;
type Read = { method: string; market: MarketContext; sellerId: Id<'Seller'>; times: unknown[] };

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 48 });
const COUNT = { count: 1, overdue: 0, oldestAt: NOW.subtract({ hours: 5 }) };
const SELLER = id<'Seller'>(0xa3);

let declarations: AccessDeclaration[];
let reads: Read[];
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
const record = (read: Read) => {
  reads.push(read);
  return failing ? Promise.reject(new Error('down')) : Promise.resolve(COUNT);
};
const admin = () => Promise.reject(new Error('not a seller count'));
const counts: CommissionPayoutsWorkQueueCountReader = {
  failedPayouts: admin,
  payoutHolds: admin,
  disputesDue: admin,
  sellerDisputesNeedingReply: (market, sellerId, now) =>
    record({ method: 'sellerDisputesNeedingReply', market, sellerId, times: [now] }),
  sellerPayoutHolds: (market, sellerId, staleBefore) =>
    record({ method: 'sellerPayoutHolds', market, sellerId, times: [staleBefore] }),
};
const USE_CASES = [
  {
    method: 'sellerDisputesNeedingReply',
    make: (deps: Deps) => new CountSellerDisputesNeedingReply(gate, deps),
    key: COMMISSION_PAYOUTS_EARNINGS_VIEW.key,
    notApproved: 'allow',
    times: [NOW],
  },
  {
    method: 'sellerPayoutHolds',
    make: (deps: Deps) => new CountSellerPayoutHolds(gate, deps),
    key: COMMISSION_PAYOUTS_EARNINGS_VIEW.key,
    notApproved: 'allow',
    times: [STALE],
  },
];

beforeEach(() => {
  declarations = [];
  reads = [];
  failing = false;
});

describe.each(TEST_MARKETS)('commission-payouts seller tasks in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const actor = (population: 'admin' | 'seller' | 'customer', sellerId = SELLER): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1),
        sessionId: id(0xa2),
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );
  const query = (signal: AbortSignal = new AbortController().signal): WorkQueueCountQuery => ({
    now: NOW,
    staleBefore: STALE,
    signal,
  });

  describe.each(USE_CASES)('$method', ({ method, make, key, notApproved, times }) => {
    const useCase = make({ unitOfWork, counts });

    it("counts behind its key for the session's seller only", async () => {
      expect(await useCase.execute(actor('seller'), query())).toEqual(ok(COUNT));
      expect(declarations).toEqual([
        expect.objectContaining({
          rule: { kind: 'permissions', allOf: [key] },
          whenSellerNotApproved: notApproved,
        }),
      ]);
      expect(reads).toEqual([{ method, market, sellerId: SELLER, times }]);
      const other = id<'Seller'>(0xb3);
      await useCase.execute(actor('seller', other), query());
      expect(reads[1]?.sellerId).toBe(other);
    });

    it('refuses a customer and an admin acting as themselves, before any read', async () => {
      expect(await useCase.execute(actor('customer'), query())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await useCase.execute(actor('admin'), query())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(reads).toHaveLength(0);
    });

    it('answers access.unavailable once the dashboard stopped waiting, or the store fails', async () => {
      const stopped = new AbortController();
      stopped.abort();
      expect(await useCase.execute(actor('seller'), query(stopped.signal))).toEqual(
        err({ code: 'access.unavailable' }),
      );
      expect(reads).toHaveLength(0);
      failing = true;
      expect(await useCase.execute(actor('seller'), query())).toEqual(
        err({ code: 'access.unavailable' }),
      );
    });
  });
});
