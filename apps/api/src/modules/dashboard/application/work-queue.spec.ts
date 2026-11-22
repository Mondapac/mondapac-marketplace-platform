import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
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
import type { PermissionKey } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { DashboardViewer } from './ports/viewer-permissions';
import { ViewAdminWorkQueue } from './use-cases/view-admin-work-queue.use-case';
import { WorkQueueCache } from './work-queue-cache';
import { composeWorkQueue } from './work-queue-flow';
import { checkWorkQueueSources, type WorkQueueSource } from './work-queue-source';

// The work-queue composer (dashboards upgrade, phase 1, design section 6) on both Market fixtures:
// only the queues whose keys the viewer holds are asked, all at once; a failed, late or malformed
// queue answers `error` and the rest still answer; an owner's refusal hides the queue; counts are
// kept for 60 seconds under the Market, the panel and the whole permission set, except live queues.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const START = Temporal.Instant.from('2026-11-22T01:00:00Z');
const key = (k: string) => k as PermissionKey;
const A = key('ordering.order.view');
const B = key('security.centre.view');

const allowAll = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true as const }),
});

interface Scripted {
  calls: { key: string; query: WorkQueueCountQuery; context: CallContext }[];
  answer: Map<string, () => Promise<unknown>>;
}

function source(
  script: Scripted,
  k: string,
  fields: Partial<Pick<WorkQueueSource, 'level' | 'requires' | 'live' | 'panel'>> = {},
): WorkQueueSource {
  return {
    key: k,
    panel: fields.panel ?? 'admin',
    level: fields.level ?? 'today',
    requires: fields.requires ?? [A],
    live: fields.live ?? false,
    count: (context, query) => {
      script.calls.push({ key: k, query, context });
      const answer = script.answer.get(k);
      return (
        answer ? answer() : Promise.resolve(ok({ count: 0, overdue: 0, oldestAt: null }))
      ) as ReturnType<WorkQueueSource['count']>;
    },
  };
}

describe.each(TEST_MARKETS)('the work queue in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const admin = (n = 0xa1) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: id(n),
        sessionId: id(n + 0x1000),
        sellerId: null,
      }),
    );
  const viewer = (keys: readonly PermissionKey[]): DashboardViewer => ({
    population: 'admin',
    sellerId: null,
    permissionKeys: keys,
  });
  let clock: FixedClock;
  let script: Scripted;
  let cache: WorkQueueCache;

  beforeEach(() => {
    clock = new FixedClock(START);
    script = { calls: [], answer: new Map() };
    cache = new WorkQueueCache();
  });

  const deps = (sources: readonly WorkQueueSource[], timeoutMs = 50) => ({
    sources,
    cache,
    clock,
    timeoutMs,
  });

  it('asks only the queues whose keys the viewer holds, with the caller context unchanged', async () => {
    const context = admin();
    script.answer.set('ordering.late', () =>
      Promise.resolve(ok({ count: 11, overdue: 4, oldestAt: START.subtract({ hours: 48 }) })),
    );
    const answer = await composeWorkQueue(
      deps([
        source(script, 'ordering.late', { requires: [A] }),
        source(script, 'security.alerts', { requires: [A, B], level: 'critical' }),
      ]),
      context,
      'admin',
      viewer([A]),
    );
    expect(script.calls.map((c) => c.key)).toEqual(['ordering.late']);
    expect(script.calls[0]!.context).toBe(context);
    expect(script.calls[0]!.query).toEqual({
      now: START,
      staleBefore: START.subtract({ hours: 48 }),
    });
    expect(answer).toEqual({
      panel: 'admin',
      generatedAt: START,
      queues: [
        {
          key: 'ordering.late',
          level: 'today',
          status: 'ok',
          count: 11,
          overdue: 4,
          oldestAt: START.subtract({ hours: 48 }),
          countedAt: START,
        },
      ],
    });
  });

  it('gives each level its default age limit', async () => {
    await composeWorkQueue(
      deps([
        source(script, 'a.critical', { level: 'critical' }),
        source(script, 'a.review', { level: 'review' }),
      ]),
      admin(),
      'admin',
      viewer([A]),
    );
    const limits = Object.fromEntries(script.calls.map((c) => [c.key, c.query.staleBefore]));
    expect(limits).toEqual({
      'a.critical': START.subtract({ hours: 1 }),
      'a.review': START.subtract({ hours: 7 * 24 }),
    });
  });

  it('orders critical, then today, then review, keeping the bound order within a level', async () => {
    const answer = await composeWorkQueue(
      deps([
        source(script, 'a.review', { level: 'review' }),
        source(script, 'a.today1'),
        source(script, 'a.critical', { level: 'critical' }),
        source(script, 'a.today2'),
      ]),
      admin(),
      'admin',
      viewer([A]),
    );
    expect(answer.queues.map((q) => q.key)).toEqual([
      'a.critical',
      'a.today1',
      'a.today2',
      'a.review',
    ]);
  });

  it('answers error for a failed, thrown, late or malformed queue, and still answers the rest', async () => {
    script.answer.set('a.failed', () => Promise.resolve(err({ code: 'access.unavailable' })));
    script.answer.set('a.thrown', () => Promise.reject(new Error('boom')));
    script.answer.set('a.late', () => new Promise(() => undefined));
    script.answer.set('a.malformed', () =>
      Promise.resolve(ok({ count: 2, overdue: 3, oldestAt: null })),
    );
    script.answer.set('a.fine', () =>
      Promise.resolve(ok({ count: 1, overdue: 0, oldestAt: START })),
    );
    const answer = await composeWorkQueue(
      deps(
        ['a.failed', 'a.thrown', 'a.late', 'a.malformed', 'a.fine'].map((k) => source(script, k)),
      ),
      admin(),
      'admin',
      viewer([A]),
    );
    expect(answer.queues.map((q) => [q.key, q.status])).toEqual([
      ['a.failed', 'error'],
      ['a.thrown', 'error'],
      ['a.late', 'error'],
      ['a.malformed', 'error'],
      ['a.fine', 'ok'],
    ]);
    expect(answer.queues.find((q) => q.status === 'error' && 'count' in q)).toBeUndefined();
  });

  it('asks every queue at once, before any of them answers', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    script.answer.set('a.first', () =>
      held.then(() => ok({ count: 1, overdue: 0, oldestAt: START })),
    );
    script.answer.set('a.second', () =>
      held.then(() => ok({ count: 2, overdue: 0, oldestAt: START })),
    );
    const answer = composeWorkQueue(
      deps([source(script, 'a.first'), source(script, 'a.second')], 5_000),
      admin(),
      'admin',
      viewer([A]),
    );
    await Promise.resolve();
    expect(script.calls.map((c) => c.key)).toEqual(['a.first', 'a.second']);
    release();
    expect((await answer).queues.map((q) => q.status)).toEqual(['ok', 'ok']);
  });

  it('leaves out a queue whose owner refuses the viewer', async () => {
    script.answer.set('a.denied', () => Promise.resolve(err({ code: 'access.denied' })));
    script.answer.set('a.pending', () =>
      Promise.resolve(err({ code: 'access.seller-not-approved', details: { state: 'pending' } })),
    );
    const answer = await composeWorkQueue(
      deps([source(script, 'a.denied'), source(script, 'a.pending'), source(script, 'a.fine')]),
      admin(),
      'admin',
      viewer([A]),
    );
    expect(answer.queues.map((q) => q.key)).toEqual(['a.fine']);
  });

  it('asks only the queues of the panel', async () => {
    const answer = await composeWorkQueue(
      deps([source(script, 'a.admin'), source(script, 'a.seller', { panel: 'seller' })]),
      admin(),
      'admin',
      viewer([A]),
    );
    expect(answer.queues.map((q) => q.key)).toEqual(['a.admin']);
  });

  it('keeps a count for 60 seconds under the same permission set, and asks again after', async () => {
    let n = 0;
    script.answer.set('a.kept', () =>
      Promise.resolve(ok({ count: ++n, overdue: 0, oldestAt: START })),
    );
    const sources = [source(script, 'a.kept')];
    const first = await composeWorkQueue(deps(sources), admin(1), 'admin', viewer([A, B]));
    clock.advance(Temporal.Duration.from({ seconds: 59 }));
    // Another admin with the same keys in another order shares the count.
    const second = await composeWorkQueue(deps(sources), admin(2), 'admin', viewer([B, A]));
    expect(script.calls).toHaveLength(1);
    expect(second.queues[0]).toMatchObject({ count: 1, countedAt: START });
    expect(second.generatedAt).toEqual(START.add({ seconds: 59 }));
    clock.advance(Temporal.Duration.from({ seconds: 1 }));
    const third = await composeWorkQueue(deps(sources), admin(1), 'admin', viewer([A, B]));
    expect(script.calls).toHaveLength(2);
    expect(first.queues[0]).toMatchObject({ count: 1 });
    expect(third.queues[0]).toMatchObject({ count: 2, countedAt: START.add({ seconds: 60 }) });
  });

  it('never shares a kept count with a viewer holding a different permission set', async () => {
    const sources = [source(script, 'a.kept')];
    await composeWorkQueue(deps(sources), admin(), 'admin', viewer([A, B]));
    await composeWorkQueue(deps(sources), admin(), 'admin', viewer([A]));
    expect(script.calls).toHaveLength(2);
  });

  it('never keeps a live queue, a failed answer or a late one', async () => {
    let failing = true;
    script.answer.set('a.flaky', () =>
      Promise.resolve(
        failing
          ? err({ code: 'access.unavailable' })
          : ok({ count: 1, overdue: 0, oldestAt: START }),
      ),
    );
    const sources = [
      source(script, 'a.live', { live: true, level: 'critical' }),
      source(script, 'a.flaky'),
    ];
    await composeWorkQueue(deps(sources), admin(), 'admin', viewer([A]));
    failing = false;
    await composeWorkQueue(deps(sources), admin(), 'admin', viewer([A]));
    await composeWorkQueue(deps(sources), admin(), 'admin', viewer([A]));
    expect(script.calls.map((c) => c.key)).toEqual([
      'a.live',
      'a.flaky',
      'a.live',
      'a.flaky',
      'a.live',
    ]);
  });

  it('keeps counts of one Market apart from another', async () => {
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const otherMarket = testMarketContext(other, PLATFORM_TENANT_ID);
    const otherAdmin = testCallContext(
      otherMarket,
      testAuthenticatedActor(otherMarket, {
        population: 'admin',
        accountId: id(0xa1),
        sessionId: id(0x10a1),
        sellerId: null,
      }),
    );
    const sources = [source(script, 'a.kept')];
    await composeWorkQueue(deps(sources), admin(), 'admin', viewer([A]));
    await composeWorkQueue(deps(sources), otherAdmin, 'admin', viewer([A]));
    expect(script.calls).toHaveLength(2);
  });

  describe('ViewAdminWorkQueue', () => {
    const useCase = (
      described: DashboardViewer | 'denied',
      sources: readonly WorkQueueSource[] = [],
    ) =>
      new ViewAdminWorkQueue(allowAll, {
        ...deps(sources),
        viewer: {
          describe: () =>
            Promise.resolve(
              described === 'denied' ? err({ code: 'access.denied' as const }) : ok(described),
            ),
        },
      });

    it('answers the composed queue for an admin', async () => {
      const result = await useCase(viewer([A]), [source(script, 'a.one')]).execute(admin(), {});
      expect(result.ok && result.value.queues.map((q) => q.key)).toEqual(['a.one']);
    });

    it('refuses a seller, a customer and the anonymous actor', async () => {
      for (const population of ['seller', 'customer'] as const) {
        const context = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population,
            accountId: id(0xb1),
            sessionId: id(0xb2),
            sellerId: population === 'seller' ? id(0xb3) : null,
          }),
        );
        expect(await useCase(viewer([A])).execute(context, {})).toEqual(
          err({ code: 'access.denied' }),
        );
      }
      expect(
        (await useCase(viewer([A])).execute(testCallContext(market, 'anonymous'), {})).ok,
      ).toBe(false);
      expect(script.calls).toHaveLength(0);
    });

    it("passes on identity's refusal", async () => {
      expect(await useCase('denied').execute(admin(), {})).toEqual(err({ code: 'access.denied' }));
    });
  });
});

describe('checkWorkQueueSources', () => {
  const script: Scripted = { calls: [], answer: new Map() };

  it('refuses a malformed key, a key bound twice in a panel and a queue without a key', () => {
    expect(() => checkWorkQueueSources([source(script, 'Bad')])).toThrow(/not <module>.<queue>/);
    expect(() => checkWorkQueueSources([source(script, 'a.one'), source(script, 'a.one')])).toThrow(
      /bound twice/,
    );
    expect(() => checkWorkQueueSources([source(script, 'a.one', { requires: [] })])).toThrow(
      /requires no permission key/,
    );
  });

  it('accepts one key in both panels', () => {
    expect(() =>
      checkWorkQueueSources([
        source(script, 'a.one'),
        source(script, 'a.one', { panel: 'seller' }),
      ]),
    ).not.toThrow();
  });
});
