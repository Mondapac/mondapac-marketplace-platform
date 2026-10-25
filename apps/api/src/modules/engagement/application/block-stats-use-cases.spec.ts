import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AccessDeclaration } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { STOREFRONT_PAGE_STATS } from '../../storefront';
import { MAX_STATS_ROWS, type BlockCountDependencies } from './block-count-flow';
import { FakeServedPlacements, InMemoryBlockCounts } from './testing/in-memory-engagement';
import { ViewBlockStats } from './use-cases/view-block-stats.use-case';

// The admin read of block counts in memory on both Market fixtures: only an actor holding
// storefront.page.stats reads; the query is checked; a page's blocks come back with their totals
// and days, most shown first; a Market never reads another's counts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const PAGE = id<'StorefrontPage'>(0xa1);
const PAGE_2 = id<'StorefrontPage'>(0xa2);
const HERO = id<'StorefrontPlacement'>(0xb1);
const SHELF = id<'StorefrontPlacement'>(0xb2);
const ANALYST = id<'Account'>(0xc1);
const EDITOR = id<'Account'>(0xc2);
const day = (value: string) => Temporal.PlainDate.from(value);
const at = Temporal.Instant.from('2026-10-25T10:00:00Z');

describe.each([['AU'], ['ZZ']] as const)('block stats in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const gate = createUseCaseGate(markets, {
    check: (context: CallContext, declaration: AccessDeclaration) => {
      const actor = context.actor;
      const held = actor.kind === 'authenticated' && actor.accountId === ANALYST;
      const rule = declaration.rule;
      const allowed =
        rule.kind !== 'permissions' ||
        (held && rule.allOf.every((key) => key === STOREFRONT_PAGE_STATS.key));
      return Promise.resolve(
        allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  });
  const admin = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      `bs-${accountId.slice(-4)}-abcd`,
    );
  const analyst = admin(ANALYST);

  let counts: InMemoryBlockCounts;
  let stats: ViewBlockStats;
  const add = (
    marketCode: string,
    pageId: Id<'StorefrontPage'>,
    placementId: Id<'StorefrontPlacement'>,
    on: string,
    impressions: number,
    clicks: number,
  ) =>
    counts.increment(marketCode === code ? market : other, day(on), at, [
      { pageId, placementId, impressions, clicks },
    ]);
  const query = (from = '2026-10-01', to = '2026-10-31', page: string = PAGE) => ({
    query: { page, from, to },
  });

  beforeEach(async () => {
    counts = new InMemoryBlockCounts();
    const deps: BlockCountDependencies = {
      unitOfWork: new FakeUnitOfWork(),
      counts,
      served: new FakeServedPlacements(),
      clock: new FixedClock(at),
    };
    stats = new ViewBlockStats(gate, deps);
    await add(code, PAGE, HERO, '2026-10-02', 5, 1);
    await add(code, PAGE, HERO, '2026-10-01', 3, 0);
    await add(code, PAGE, SHELF, '2026-10-01', 20, 4);
    await add(code, PAGE, SHELF, '2026-09-30', 99, 9);
    await add(code, PAGE_2, HERO, '2026-10-01', 7, 7);
    await add(other.marketId, PAGE, HERO, '2026-10-01', 1000, 1000);
  });

  it('answers each block with its totals and days in the span, most shown first', async () => {
    const result = await stats.execute(analyst, query());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(false);
    expect(result.value.pageId).toBe(PAGE);
    expect(result.value.from.toString()).toBe('2026-10-01');
    expect(
      result.value.blocks.map((b) => ({
        placementId: b.placementId,
        impressions: b.impressions,
        clicks: b.clicks,
        days: b.days.map((d) => `${d.day.toString()}:${d.impressions}/${d.clicks}`),
      })),
    ).toEqual([
      { placementId: SHELF, impressions: 20, clicks: 4, days: ['2026-10-01:20/4'] },
      {
        placementId: HERO,
        impressions: 8,
        clicks: 1,
        days: ['2026-10-01:3/0', '2026-10-02:5/1'],
      },
    ]);
  });

  it('includes both ends of the span and never another Market', async () => {
    const one = await stats.execute(analyst, query('2026-09-30', '2026-09-30'));
    expect(one.ok && one.value.blocks.map((b) => [b.placementId, b.impressions])).toEqual([
      [SHELF, 99],
    ]);
    const unknown = await stats.execute(analyst, query(undefined, undefined, id(0xff)));
    expect(unknown.ok && unknown.value.blocks).toEqual([]);
  });

  it('refuses an actor without storefront.page.stats and an anonymous caller', async () => {
    expect(await stats.execute(admin(EDITOR), query())).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    const anonymous = await stats.execute(testCallContext(market, 'anonymous'), query());
    expect(anonymous.ok).toBe(false);
  });

  it.each([
    [{ page: PAGE, from: '2026-10-01' }, [{ path: 'to', code: 'required' }]],
    [{ page: 'nope', from: '2026-10-01', to: '2026-10-02' }, [{ path: 'page', code: 'format' }]],
    [{ page: PAGE, from: '2026-02-30', to: '2026-03-02' }, [{ path: 'from', code: 'format' }]],
    [{ page: PAGE, from: '2026-10-1', to: '2026-10-02' }, [{ path: 'from', code: 'format' }]],
    [
      { page: PAGE, from: '0050-01-01', to: '2026-10-01' },
      [{ path: 'from', code: 'out-of-range' }],
    ],
    [{ page: PAGE, from: '2026-10-02', to: '2026-10-01' }, [{ path: 'to', code: 'before-from' }]],
    [{ page: PAGE, from: '2026-01-01', to: '2026-04-03' }, [{ path: 'to', code: 'span-too-long' }]],
    [
      { page: PAGE, from: '2026-10-01', to: '2026-10-02', x: '1' },
      [{ path: '', code: 'unknown-field' }],
    ],
    [
      { page: [PAGE, PAGE], from: '2026-10-01', to: '2026-10-02' },
      [{ path: 'page', code: 'type' }],
    ],
  ])('refuses the query %j', async (q, fields) => {
    expect(await stats.execute(analyst, { query: q })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields },
    });
  });

  it('allows a span of exactly 92 days', async () => {
    const result = await stats.execute(analyst, query('2026-01-01', '2026-04-02'));
    expect(result.ok).toBe(true);
  });

  it('says when a span holds more rows than one read loads', async () => {
    counts = new InMemoryBlockCounts();
    stats = new ViewBlockStats(gate, {
      unitOfWork: new FakeUnitOfWork(),
      counts,
      served: new FakeServedPlacements(),
      clock: new FixedClock(at),
    });
    const start = day('2026-07-01');
    for (let n = 0; n <= MAX_STATS_ROWS / 90; n += 1) {
      const placement = id<'StorefrontPlacement'>(0x1000 + n);
      for (let d = 0; d < 90; d += 1) {
        await counts.increment(market, start.add({ days: d }), at, [
          { pageId: PAGE, placementId: placement, impressions: 1, clicks: 0 },
        ]);
      }
    }
    const result = await stats.execute(analyst, query('2026-07-01', '2026-09-28'));
    expect(result.ok && result.value.truncated).toBe(true);
    expect(result.ok && result.value.blocks.reduce((sum, b) => sum + b.days.length, 0)).toBe(
      MAX_STATS_ROWS,
    );
  });
});
