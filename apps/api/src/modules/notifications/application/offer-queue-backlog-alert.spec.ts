import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { expectSystemOnly } from '../../../../test/support/system-only-denial';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CatalogWorkQueueFacade, OfferReviewQueueSnapshot } from '../../catalog';
import type { OfferQueueBacklogLimits, SettingsFacade } from '../../settings';
import {
  ADMIN_NOTICE_KINDS,
  ADMIN_NOTICES_PER_MARKET,
  ADMIN_OFFER_QUEUE_BACKLOG,
  parseNoticeParams,
} from '../domain/in-app-notice';
import type { OfferQueueBacklogReason } from '../domain/offer-queue-backlog';
import { ConfigNotificationsPolicy } from '../infrastructure/config-notifications-policy';
import type { InAppNoticeRepository, NewNotice } from './ports/in-app-notice.repository';
import type { OfferQueueBacklogRepository } from './ports/offer-queue-backlog.repository';
import { RaiseOfferQueueBacklogAlert } from './use-cases/raise-offer-queue-backlog-alert.use-case';

// The Offer review queue backlog alert (risk-based Offer approval, slice 8) in memory on both
// Market fixtures: one admin notice for each crossing of a limit, re-armed once the queue is back
// within both, never for an unreadable queue, and no notice of another Market.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

class MemoryNotices {
  rows: (NewNotice & { market: string })[] = [];
  trims: { owner: string; keep: number; kind?: string }[] = [];
  add = (market: MarketContext, notices: readonly NewNotice[]) => {
    this.rows.push(...notices.map((notice) => ({ ...notice, market: market.marketId })));
    return Promise.resolve();
  };
  trim = (_market: MarketContext, owner: { audience: string }, keep: number, kind?: string) => {
    this.trims.push({ owner: owner.audience, keep, ...(kind === undefined ? {} : { kind }) });
    return Promise.resolve(0);
  };
}

class MemoryBacklog implements OfferQueueBacklogRepository {
  /** The open alert of each Market, with the time it was raised. */
  open = new Map<string, Temporal.Instant>();
  raised: { market: string; reason: OfferQueueBacklogReason; size: number }[] = [];
  cleared = 0;
  raise(
    market: MarketContext,
    at: Temporal.Instant,
    reason: OfferQueueBacklogReason,
    size: number,
  ) {
    if (this.open.has(market.marketId)) return Promise.resolve(false);
    this.open.set(market.marketId, at);
    this.raised.push({ market: market.marketId, reason, size });
    return Promise.resolve(true);
  }
  clear(market: MarketContext) {
    const had = this.open.delete(market.marketId);
    if (had) this.cleared += 1;
    return Promise.resolve(had);
  }
}

describe.each([['AU'], ['ZZ']] as const)('Offer queue backlog alert in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const system = testCallContext(market, 'system', 'backlog-sys-0001');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const zone = markets.get(market.marketId).timezone;

  let notices: MemoryNotices;
  let backlog: MemoryBacklog;
  let unitOfWork: FakeUnitOfWork;
  let clock: FixedClock;
  let queue: () => Result<
    OfferReviewQueueSnapshot,
    { code: 'access.unavailable' | 'access.denied' }
  >;
  let limits: OfferQueueBacklogLimits;
  let nextId: number;

  const build = () =>
    new RaiseOfferQueueBacklogAlert(gate, {
      unitOfWork,
      notices: notices as unknown as InAppNoticeRepository,
      backlog,
      catalogQueue: {
        offerReviewQueue: () => Promise.resolve(queue()),
      } as unknown as CatalogWorkQueueFacade,
      settings: {
        offerQueueBacklogLimits: () => Promise.resolve(limits),
      } as unknown as SettingsFacade,
      policy: new ConfigNotificationsPolicy(markets),
      ids: { next: () => id((nextId += 1)) } as never,
      clock,
    });

  /** A Tuesday, 10:00 in the Market's zone, so the oldest wait is the distance back to `oldestAt`. */
  const NOW = Temporal.ZonedDateTime.from({
    year: 2026,
    month: 11,
    day: 24,
    hour: 10,
    timeZone: zone,
  }).toInstant();
  const hoursAgo = (hours: number) => NOW.subtract({ hours });

  beforeEach(() => {
    notices = new MemoryNotices();
    backlog = new MemoryBacklog();
    unitOfWork = new FakeUnitOfWork();
    clock = new FixedClock(NOW);
    limits = { count: 50, hours: 24 };
    nextId = 0x100;
    queue = () => ok({ count: 3, oldestAt: hoursAgo(2) });
  });

  it('raises nothing while the queue is within both limits, and clears no alert', async () => {
    const result = await build().execute(system, {});
    expect(result).toEqual(ok({ code: 'backlog.within-limits', rearmed: false }));
    expect(notices.rows).toEqual([]);
    expect(backlog.raised).toEqual([]);
  });

  it('raises one admin notice when the oldest Offer has waited more than the set hours', async () => {
    queue = () => ok({ count: 3, oldestAt: hoursAgo(26) });
    const result = await build().execute(system, {});
    expect(result).toEqual(ok({ code: 'backlog.alerted', notices: 1 }));
    expect(notices.rows).toHaveLength(1);
    const [notice] = notices.rows;
    expect(notice).toMatchObject({
      market: market.marketId,
      owner: { audience: 'admin' },
      kind: ADMIN_OFFER_QUEUE_BACKLOG,
      params: { reason: 'age', count: 3, hours: 26 },
    });
    // The notice reads back as an admin notice with only its reason, size and wait.
    expect(ADMIN_NOTICE_KINDS).toContain(ADMIN_OFFER_QUEUE_BACKLOG);
    expect(parseNoticeParams(ADMIN_OFFER_QUEUE_BACKLOG, notice?.params)).toEqual({
      reason: 'age',
      count: 3,
      hours: 26,
    });
    expect(notices.trims).toEqual([
      { owner: 'admin', keep: ADMIN_NOTICES_PER_MARKET, kind: ADMIN_OFFER_QUEUE_BACKLOG },
    ]);
  });

  it('raises for a queue larger than the set size, and names both reasons when both hold', async () => {
    queue = () => ok({ count: 51, oldestAt: hoursAgo(1) });
    await build().execute(system, {});
    expect(backlog.raised.map((alert) => alert.reason)).toEqual(['size']);
    // A wider queue and a stale one: the crossing is the same alert, still one notice.
    queue = () => ok({ count: 60, oldestAt: hoursAgo(30) });
    expect(await build().execute(system, {})).toEqual(ok({ code: 'backlog.already-alerted' }));
    expect(notices.rows).toHaveLength(1);
  });

  it('names both reasons when both limits are passed at once', async () => {
    queue = () => ok({ count: 51, oldestAt: hoursAgo(30) });
    await build().execute(system, {});
    expect(notices.rows[0]?.params).toMatchObject({ reason: 'both', count: 51 });
  });

  it('sends one alert for each crossing, not one for each run or each Offer', async () => {
    queue = () => ok({ count: 90, oldestAt: hoursAgo(40) });
    const first = await build().execute(system, {});
    const second = await build().execute(system, {});
    const third = await build().execute(system, {});
    expect([first, second, third]).toEqual([
      ok({ code: 'backlog.alerted', notices: 1 }),
      ok({ code: 'backlog.already-alerted' }),
      ok({ code: 'backlog.already-alerted' }),
    ]);
    expect(notices.rows).toHaveLength(1);
  });

  it('is armed again after the queue returns within both limits, then alerts a second crossing', async () => {
    queue = () => ok({ count: 90, oldestAt: hoursAgo(40) });
    await build().execute(system, {});
    queue = () => ok({ count: 4, oldestAt: hoursAgo(3) });
    expect(await build().execute(system, {})).toEqual(
      ok({ code: 'backlog.within-limits', rearmed: true }),
    );
    expect(await build().execute(system, {})).toEqual(
      ok({ code: 'backlog.within-limits', rearmed: false }),
    );
    queue = () => ok({ count: 90, oldestAt: hoursAgo(40) });
    expect(await build().execute(system, {})).toEqual(ok({ code: 'backlog.alerted', notices: 1 }));
    expect(notices.rows).toHaveLength(2);
  });

  it('uses the limits the admin set, and takes the size as strictly more than the limit', async () => {
    limits = { count: 3, hours: 48 };
    queue = () => ok({ count: 3, oldestAt: hoursAgo(30) });
    expect(await build().execute(system, {})).toEqual(
      ok({ code: 'backlog.within-limits', rearmed: false }),
    );
    queue = () => ok({ count: 4, oldestAt: hoursAgo(30) });
    expect(await build().execute(system, {})).toEqual(ok({ code: 'backlog.alerted', notices: 1 }));
  });

  it('keeps one Market from alerting, or silencing, another', async () => {
    queue = () => ok({ count: 90, oldestAt: hoursAgo(40) });
    await build().execute(system, {});
    const otherSystem = testCallContext(other, 'system', 'backlog-sys-0002');
    expect(await build().execute(otherSystem, {})).toEqual(
      ok({ code: 'backlog.alerted', notices: 1 }),
    );
    expect(notices.rows.map((row) => row.market).sort()).toEqual(
      [market.marketId, other.marketId].sort(),
    );
  });

  it('raises nothing, and clears no open alert, when the queue cannot be read', async () => {
    queue = () => ok({ count: 90, oldestAt: hoursAgo(40) });
    await build().execute(system, {});
    queue = () => err({ code: 'access.unavailable' });
    expect(await build().execute(system, {})).toEqual(err({ code: 'backlog.unavailable' }));
    expect(backlog.open.has(market.marketId)).toBe(true);
    expect(notices.rows).toHaveLength(1);
  });

  it('is for the system actor only', async () => {
    await expectSystemOnly(code, (context) => build().execute(context, {}));
    expect(notices.rows).toEqual([]);
  });
});
