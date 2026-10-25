import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { BlockCountDependencies } from './block-count-flow';
import { FakeServedPlacements, InMemoryBlockCounts } from './testing/in-memory-engagement';
import { PurgeExpiredBlockCounts } from './use-cases/purge-expired-block-counts.use-case';
import { RecordBlockEvents } from './use-cases/record-block-events.use-case';

// Block counts in memory on both Market fixtures: an event is counted only for a placement
// storefront serves now on that page in this Market; identical events of a request count once;
// Global Privacy Control counts nothing; the day is the UTC day of the Clock; a Market never sees
// another's counts; counts older than 13 months are purged.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T23:30:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const PAGE = id<'StorefrontPage'>(0xa1);
const PAGE_2 = id<'StorefrontPage'>(0xa2);
const HERO = id<'StorefrontPlacement'>(0xb1);
const SHELF = id<'StorefrontPlacement'>(0xb2);
const UNSERVED = id<'StorefrontPlacement'>(0xb3);
const quiet = { globalPrivacyControl: false };

describe.each([['AU'], ['ZZ']] as const)('block counts in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const anonymous = testCallContext(market, 'anonymous');
  const system = testCallContext(market, 'system');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let counts: InMemoryBlockCounts;
  let served: FakeServedPlacements;
  let record: RecordBlockEvents;
  let purge: PurgeExpiredBlockCounts;
  const event = (type: 'impression' | 'click', placementId = HERO, pageId = PAGE) => ({
    pageId,
    placementId,
    type,
  });
  const rows = () => [...counts.rows.values()].filter((row) => row.marketId === code);
  const only = () => {
    expect(rows()).toHaveLength(1);
    return rows()[0]!;
  };

  beforeEach(() => {
    clock = new FixedClock(T0);
    counts = new InMemoryBlockCounts();
    served = new FakeServedPlacements();
    served.serve(code, PAGE, [HERO, SHELF]);
    served.serve(other.marketId, PAGE, [HERO, SHELF]);
    const deps: BlockCountDependencies = {
      unitOfWork: new FakeUnitOfWork(),
      counts,
      served,
      clock,
    };
    record = new RecordBlockEvents(gate, deps);
    purge = new PurgeExpiredBlockCounts(gate, deps);
  });

  it('counts impressions and clicks per block on the UTC day of the Clock', async () => {
    const result = await record.execute(anonymous, {
      events: [event('impression'), event('click'), event('impression', SHELF)],
      ...quiet,
    });
    expect(result).toEqual({ ok: true, value: { recorded: true } });
    expect(rows().map((row) => [row.placementId, row.impressions, row.clicks, row.day])).toEqual([
      [HERO, 1, 1, '2026-10-25'],
      [SHELF, 1, 0, '2026-10-25'],
    ]);

    // Another request adds to the same row; after midnight UTC a new row starts.
    await record.execute(anonymous, { events: [event('impression')], ...quiet });
    clock.set(Temporal.Instant.from('2026-10-26T00:00:01Z'));
    await record.execute(anonymous, { events: [event('click')], ...quiet });
    expect(
      rows()
        .filter((row) => row.placementId === HERO)
        .map((row) => [row.day, row.impressions, row.clicks]),
    ).toEqual([
      ['2026-10-25', 2, 1],
      ['2026-10-26', 0, 1],
    ]);
  });

  it('counts identical events of one request once', async () => {
    await record.execute(anonymous, {
      events: [event('impression'), event('impression'), event('click'), event('click')],
      ...quiet,
    });
    expect(only()).toMatchObject({ impressions: 1, clicks: 1 });
  });

  it('skips a placement that is not served on that page, silently, and counts the rest', async () => {
    const result = await record.execute(anonymous, {
      events: [
        event('impression', UNSERVED),
        event('click', HERO, PAGE_2),
        event('impression', SHELF),
      ],
      ...quiet,
    });
    // The answer is the same as for a fully valid request; nothing says which events counted.
    expect(result).toEqual({ ok: true, value: { recorded: true } });
    expect(rows().map((row) => row.placementId)).toEqual([SHELF]);

    const none = await record.execute(anonymous, {
      events: [event('impression', UNSERVED)],
      ...quiet,
    });
    expect(none).toEqual({ ok: true, value: { recorded: false } });
    expect(rows()).toHaveLength(1);
  });

  it('counts a placement only in the Market that serves it', async () => {
    served.served.delete(`${code}|${PAGE}`);
    await record.execute(anonymous, { events: [event('impression')], ...quiet });
    expect(counts.rows.size).toBe(0);

    served.serve(code, PAGE, [HERO]);
    await record.execute(anonymous, { events: [event('impression')], ...quiet });
    expect([...counts.rows.values()].map((row) => row.marketId)).toEqual([code]);
  });

  it('asks storefront once per distinct page and writes blocks in a fixed order', async () => {
    served.serve(code, PAGE_2, [HERO]);
    await record.execute(anonymous, {
      events: [
        event('impression', HERO, PAGE_2),
        event('impression', SHELF),
        event('click', HERO),
        event('impression', HERO),
      ],
      ...quiet,
    });
    expect(served.asked).toEqual([PAGE_2, PAGE]);
    expect(counts.calls).toEqual([[`${PAGE}|${HERO}`, `${PAGE}|${SHELF}`, `${PAGE_2}|${HERO}`]]);
  });

  it('counts nothing, and asks storefront nothing, with Global Privacy Control', async () => {
    const result = await record.execute(anonymous, {
      events: [event('impression')],
      globalPrivacyControl: true,
    });
    expect(result).toEqual({ ok: true, value: { recorded: false } });
    expect(counts.rows.size).toBe(0);
    expect(served.asked).toEqual([]);
  });

  it('still refuses a malformed body with Global Privacy Control, naming only the field', async () => {
    const result = await record.execute(anonymous, {
      events: [{ pageId: 'x', placementId: HERO, type: 'click', note: 'private' }],
      globalPrivacyControl: true,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'events.0', code: 'unknown-field' },
          { path: 'events.0.pageId', code: 'format' },
        ],
      },
    });
    expect(counts.rows.size).toBe(0);
  });

  it('is open to a signed-in caller too and keeps no account anywhere', async () => {
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: id<'Account'>(0xc1),
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'blocks-customer-abcd',
    );
    // The rule is `anonymous`: a session is not read, so nothing of the account reaches a row.
    const result = await record.execute(customer, { events: [event('impression')], ...quiet });
    expect(result.ok).toBe(true);
    expect(Object.keys(only()).sort()).toEqual([
      'clicks',
      'day',
      'impressions',
      'marketId',
      'pageId',
      'placementId',
      'updatedAt',
    ]);
  });

  it('purges the Market’s counts older than 13 months, and only those', async () => {
    const days = ['2025-09-24', '2025-09-25', '2026-10-25'];
    for (const day of days) {
      for (const marketId of [code, other.marketId]) {
        counts.rows.set(`${marketId}|${PAGE}|${HERO}|${day}`, {
          marketId,
          pageId: PAGE,
          placementId: HERO,
          day,
          impressions: 1,
          clicks: 0,
          updatedAt: T0,
        });
      }
    }
    const result = await purge.execute(system, {});
    expect(result).toEqual({ ok: true, value: { blockCounts: 1 } });
    expect(rows().map((row) => row.day)).toEqual(['2025-09-25', '2026-10-25']);
    expect([...counts.rows.values()].filter((row) => row.marketId === other.marketId)).toHaveLength(
      3,
    );
    expect(await purge.execute(system, {})).toEqual({ ok: true, value: { blockCounts: 0 } });
  });

  it('lets only the system purge', async () => {
    const result = await purge.execute(anonymous, {});
    expect(result.ok).toBe(false);
  });
});
