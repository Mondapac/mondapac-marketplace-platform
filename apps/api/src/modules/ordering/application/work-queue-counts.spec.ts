import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
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
import { ORDERING_ORDER_VIEW } from '../contracts/permissions';
import type { WorkQueueCountReader } from './ports/work-queue-count.reader';
import { CountLateDeliveries } from './use-cases/count-late-deliveries.use-case';
import { CountPendingRefunds } from './use-cases/count-pending-refunds.use-case';

// The ordering counts of the dashboard's work queue (dashboards upgrade, phase 1), on both Market
// fixtures: the key `ordering.order.view`, platform admins only, the query's times passed to the
// reader in the caller's Market, and `access.unavailable` once the dashboard stopped waiting or
// the store fails.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 1 });
const COUNT = { count: 3, overdue: 1, oldestAt: NOW.subtract({ hours: 4 }) };

describe.each(TEST_MARKETS)('ordering work-queue counts in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const actor = (population: 'admin' | 'seller') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1),
        sessionId: id(0xa2),
        sellerId: population === 'seller' ? id(0xa3) : null,
      }),
    );
  let declarations: AccessDeclaration[];
  let reads: { method: string; market: MarketContext; times: Temporal.Instant[] }[];
  let signals: AbortSignal[];
  let failing: boolean;

  const gate = createUseCaseGate(markets, {
    check: (_context, declaration) => {
      declarations.push(declaration);
      return Promise.resolve({ allowed: true as const });
    },
  });
  const unitOfWork = {
    run: (
      _market: MarketContext,
      work: () => Promise<unknown>,
      options?: { readOnly?: boolean },
    ) => {
      if (options?.readOnly !== true) throw new Error('expected a read-only unit');
      return work();
    },
  } as unknown as UnitOfWork;
  const counts: WorkQueueCountReader = {
    lateDeliveries: (m, now, overdueBefore, signal) => {
      signals.push(signal);
      reads.push({ method: 'late', market: m, times: [now, overdueBefore] });
      return failing ? Promise.reject(new Error('down')) : Promise.resolve(COUNT);
    },
    pendingRefunds: (m, staleBefore) => {
      reads.push({ method: 'refunds', market: m, times: [staleBefore] });
      return failing ? Promise.reject(new Error('down')) : Promise.resolve(COUNT);
    },
  };
  const late = new CountLateDeliveries(gate, { unitOfWork, counts });
  const refunds = new CountPendingRefunds(gate, { unitOfWork, counts });
  const query = (signal: AbortSignal = new AbortController().signal) => ({
    now: NOW,
    staleBefore: STALE,
    signal,
  });

  beforeEach(() => {
    declarations = [];
    reads = [];
    signals = [];
    failing = false;
  });

  it('counts late deliveries and pending refunds behind ordering.order.view', async () => {
    expect(await late.execute(actor('admin'), query())).toEqual(ok(COUNT));
    expect(await refunds.execute(actor('admin'), query())).toEqual(ok(COUNT));
    expect(declarations.map((d) => d.rule)).toEqual([
      { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
      { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
    ]);
    expect(reads).toEqual([
      { method: 'late', market, times: [NOW, STALE] },
      { method: 'refunds', market, times: [STALE] },
    ]);
  });

  it("hands the dashboard's signal to the late read, which stops between its rounds", async () => {
    const waiting = new AbortController();
    await late.execute(actor('admin'), query(waiting.signal));
    expect(signals).toEqual([waiting.signal]);
  });

  it('refuses anyone but a platform admin, before any read', async () => {
    expect(await late.execute(actor('seller'), query())).toEqual(err({ code: 'access.denied' }));
    expect(await refunds.execute(actor('seller'), query())).toEqual(err({ code: 'access.denied' }));
    expect(reads).toHaveLength(0);
  });

  it('answers access.unavailable once the dashboard stopped waiting, or the store fails', async () => {
    const stopped = new AbortController();
    stopped.abort();
    expect(await late.execute(actor('admin'), query(stopped.signal))).toEqual(
      err({ code: 'access.unavailable' }),
    );
    expect(reads).toHaveLength(0);
    failing = true;
    expect(await refunds.execute(actor('admin'), query())).toEqual(
      err({ code: 'access.unavailable' }),
    );
  });
});
