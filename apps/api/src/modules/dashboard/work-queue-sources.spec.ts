import { ok, Temporal } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { PLATFORM_TENANT_ID } from '../../platform/market-context/tenant';
import { ORDERING_ORDER_VIEW } from '../ordering';
import { checkWorkQueueSources } from './application/work-queue-source';
import { workQueueSources, type WorkQueueOwners } from './dashboard.module';

// The bound sources of the work queue (dashboards upgrade, phase 1): each queue's key, panel, level,
// keys and cache mode as the design gives them, and each one calls its owner's facade method with
// the caller's context and query unchanged.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const COUNT = { count: 1, overdue: 0, oldestAt: NOW };

describe('the bound work-queue sources', () => {
  const calls: { method: string; context: unknown; query: unknown }[] = [];
  const record = (method: string) => (context: unknown, query: unknown) => {
    calls.push({ method, context, query });
    return Promise.resolve(ok(COUNT));
  };
  const owners: WorkQueueOwners = {
    ordering: {
      lateDeliveries: record('ordering.lateDeliveries'),
      pendingRefunds: record('ordering.pendingRefunds'),
    },
  };
  const sources = workQueueSources(owners);

  it('passes the boot check', () => {
    expect(() => checkWorkQueueSources(sources)).not.toThrow();
  });

  it('binds each queue as the design gives it', () => {
    expect(
      sources.map(({ key, panel, level, requires, live }) => ({
        key,
        panel,
        level,
        requires,
        live,
      })),
    ).toEqual([
      {
        key: 'ordering.late-deliveries',
        panel: 'admin',
        level: 'critical',
        requires: [ORDERING_ORDER_VIEW.key],
        live: false,
      },
      {
        key: 'ordering.pending-refunds',
        panel: 'admin',
        level: 'today',
        requires: [ORDERING_ORDER_VIEW.key],
        live: false,
      },
    ]);
  });

  it("calls each owner's facade with the caller's context and query unchanged", async () => {
    const market = testMarketContext('AU', PLATFORM_TENANT_ID);
    const context = testCallContext(market, 'system');
    const query = { now: NOW, staleBefore: NOW, signal: new AbortController().signal };
    for (const source of sources) expect(await source.count(context, query)).toEqual(ok(COUNT));
    expect(calls.map((c) => c.method)).toEqual([
      'ordering.lateDeliveries',
      'ordering.pendingRefunds',
    ]);
    expect(calls.every((c) => c.context === context && c.query === query)).toBe(true);
  });
});
