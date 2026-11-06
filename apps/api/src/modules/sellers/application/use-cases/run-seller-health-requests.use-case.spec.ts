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
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { DefaultSellerHealthPolicy } from '../../infrastructure/default-seller-health-policy';
import type { SellerHealthDay } from '../../domain/seller-health-days';
import {
  SELLER_HEALTH_REQUEST_PAGE_MAX,
  type SellerHealthRequest,
  type SellerHealthRequestStore,
} from '../ports/seller-health-request.store';
import type { SellerHealthRoster } from '../ports/seller-health-roster';
import type { SellerHealthSignals } from '../ports/seller-health-signals';
import type { SellerHealthSnapshot, SellerHealthStore } from '../ports/seller-health.store';
import {
  RunSellerHealthRequests,
  SELLER_HEALTH_REQUEST_BATCH,
  SELLER_HEALTH_REQUEST_MAX_PAGES,
} from './run-seller-health-requests.use-case';

// `sellers.run-seller-health-requests` in memory, on both Market fixtures: it measures the pending
// requests now (even when today already has a snapshot) in each seller's own zone, marks them done
// or failed, isolates a failing one, keeps the Markets apart and refuses a non-system actor.

// 2026-11-10 23:30 UTC: already 2026-11-11 in Brisbane (+10).
const NOW = Temporal.Instant.from('2026-11-10T23:30:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const BRISBANE = 'Australia/Brisbane';

describe.each(['AU', 'ZZ'] as const)('sellers.run-seller-health-requests (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);

  let approved: Map<string, string>;
  let requests: (SellerHealthRequest & { marketId: string; status: string })[];
  let finished: { id: Id; status: string }[];
  let snaps: Map<string, SellerHealthSnapshot>;
  let asked: { seller: Id<'Seller'>; days: string[]; zone: string }[];
  let failing: Set<Id<'Seller'>>;
  let units: { readOnly: boolean }[];

  const request = (sellerId: Id<'Seller'>, marketId = market.marketId) => {
    const row = {
      id: ids.next(),
      marketId,
      sellerId,
      source: 'admin' as const,
      requestedAt: NOW,
      status: 'pending' as const,
    };
    requests.push(row);
    return row;
  };

  const useCase = () => {
    const unitOfWork: UnitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>, opts?: unknown) => {
        units.push({ readOnly: (opts as { readOnly?: boolean } | undefined)?.readOnly === true });
        return work();
      },
      runOnce: noRunOnce,
    };
    const healthRoster: SellerHealthRoster = {
      page: () => Promise.resolve([]),
      one: (m, seller) => {
        const zone = approved.get(`${m.marketId}|${seller}`);
        return Promise.resolve(zone === undefined ? null : { sellerId: seller, zone });
      },
    };
    const healthRequests: SellerHealthRequestStore = {
      enqueue: () => Promise.resolve({ queued: true }),
      pending: (m, limit) =>
        Promise.resolve(
          requests
            .filter((row) => row.marketId === m.marketId && row.status === 'pending')
            .slice(0, limit),
        ),
      finish: (m, id, status) => {
        const row = requests.find((r) => r.id === id && r.marketId === m.marketId);
        if (row === undefined || row.status !== 'pending') return Promise.resolve(false);
        row.status = status;
        finished.push({ id, status });
        return Promise.resolve(true);
      },
      latest: () => Promise.resolve(null),
    };
    const days = new Map<string, SellerHealthDay>();
    const healthStore: SellerHealthStore = {
      saveDay: (m, seller, day) => {
        days.set(`${m.marketId}|${seller}|${day.day.toString()}`, day);
        return Promise.resolve();
      },
      days: (m, seller, from, to) =>
        Promise.resolve(
          [...days.entries()]
            .filter(
              ([key, day]) =>
                key.startsWith(`${m.marketId}|${seller}|`) &&
                Temporal.PlainDate.compare(day.day, from) >= 0 &&
                Temporal.PlainDate.compare(day.day, to) <= 0,
            )
            .map(([, day]) => day),
        ),
      saveSnapshot: (m, seller, snapshot) => {
        snaps.set(`${m.marketId}|${seller}|${snapshot.day.toString()}`, snapshot);
        return Promise.resolve();
      },
      purgeBefore: () => Promise.resolve({ days: 0, snapshots: 0 }),
      snapshots: () => Promise.resolve([]),
      latest: () => Promise.resolve(new Map()),
      unhealthy: () => Promise.resolve({ sellers: [], truncated: false }),
    };
    const healthSignals: SellerHealthSignals = {
      days: (_c, seller, wanted, zone) => {
        asked.push({ seller, days: wanted.map(String), zone });
        if (failing.has(seller)) return Promise.reject(new Error('feed down'));
        return Promise.resolve(
          wanted.map((day) => ({
            day,
            paidOrders: 12,
            readyOrders: 12,
            lateReadyOrders: 0,
            lostDisputes: 0,
            reviewsApproved: 0,
            ratingStarsSum: 0,
          })),
        );
      },
    };
    return new RunSellerHealthRequests(gate, {
      unitOfWork,
      healthRoster,
      healthRequests,
      healthStore,
      healthSignals,
      healthPolicy: new DefaultSellerHealthPolicy(),
      clock,
    });
  };

  const system = testCallContext(market, 'system');
  const seller = (n: number) =>
    `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Seller'>;

  beforeEach(() => {
    approved = new Map();
    requests = [];
    finished = [];
    snaps = new Map();
    asked = [];
    failing = new Set();
    units = [];
  });

  it("measures a requested seller now, in the seller's zone, and marks the request done", async () => {
    approved.set(`${market.marketId}|${seller(1)}`, BRISBANE);
    approved.set(`${market.marketId}|${seller(2)}`, 'UTC');
    const first = request(seller(1));
    const second = request(seller(2));
    const result = await useCase().execute(system, {});
    expect(result).toEqual({ ok: true, value: { done: 2, failed: 0 } });
    expect(asked).toEqual([
      { seller: seller(1), days: ['2026-11-09', '2026-11-10', '2026-11-11'], zone: BRISBANE },
      { seller: seller(2), days: ['2026-11-08', '2026-11-09', '2026-11-10'], zone: 'UTC' },
    ]);
    expect(snaps.has(`${market.marketId}|${seller(1)}|2026-11-11`)).toBe(true);
    expect(snaps.has(`${market.marketId}|${seller(2)}|2026-11-10`)).toBe(true);
    expect(finished).toEqual([
      { id: first.id, status: 'done' },
      { id: second.id, status: 'done' },
    ]);
  });

  it('measures again when the local date already has a snapshot, and a repeat adds nothing', async () => {
    approved.set(`${market.marketId}|${seller(1)}`, 'UTC');
    request(seller(1));
    await useCase().execute(system, {});
    request(seller(1));
    const again = await useCase().execute(system, {});
    expect(again).toEqual({ ok: true, value: { done: 1, failed: 0 } });
    expect(asked).toHaveLength(2);
    expect(snaps.size).toBe(1);
  });

  it('marks a request failed when the seller has no approved file, reading no feed', async () => {
    const row = request(seller(9));
    const result = await useCase().execute(system, {});
    expect(result).toEqual({ ok: true, value: { done: 0, failed: 1 } });
    expect(asked).toEqual([]);
    expect(finished).toEqual([{ id: row.id, status: 'failed' }]);
  });

  it('isolates a failing request: it is reported and failed, the others are measured', async () => {
    for (const n of [1, 2, 3]) approved.set(`${market.marketId}|${seller(n)}`, 'UTC');
    request(seller(1));
    const bad = request(seller(2));
    request(seller(3));
    failing.add(seller(2));
    const reported: Id<'Seller'>[] = [];
    const result = await useCase().execute(system, { onFailure: (id) => reported.push(id) });
    expect(result).toEqual({ ok: true, value: { done: 2, failed: 1 } });
    expect(reported).toEqual([seller(2)]);
    expect(finished.find((f) => f.id === bad.id)).toEqual({ id: bad.id, status: 'failed' });
    expect(snaps.has(`${market.marketId}|${seller(2)}|2026-11-10`)).toBe(false);
  });

  it('works only on the requests of its own Market', async () => {
    approved.set(`${market.marketId}|${seller(1)}`, 'UTC');
    approved.set(`${other.marketId}|${seller(2)}`, 'UTC');
    request(seller(1));
    const foreign = request(seller(2), other.marketId);
    const result = await useCase().execute(system, {});
    expect(result).toEqual({ ok: true, value: { done: 1, failed: 0 } });
    expect(foreign.status).toBe('pending');
    expect(asked.map((a) => a.seller)).toEqual([seller(1)]);
  });

  it('does one cheap read-only read when nothing waits', async () => {
    const result = await useCase().execute(system, {});
    expect(result).toEqual({ ok: true, value: { done: 0, failed: 0 } });
    expect(units).toEqual([{ readOnly: true }]);
  });

  it('works through more requests than one batch, in pages, within the page limit', async () => {
    const total = SELLER_HEALTH_REQUEST_BATCH + 3;
    expect(total).toBeLessThanOrEqual(
      SELLER_HEALTH_REQUEST_BATCH * SELLER_HEALTH_REQUEST_MAX_PAGES,
    );
    expect(SELLER_HEALTH_REQUEST_BATCH).toBeLessThanOrEqual(SELLER_HEALTH_REQUEST_PAGE_MAX);
    for (let n = 1; n <= total; n += 1) {
      approved.set(`${market.marketId}|${seller(n)}`, 'UTC');
      request(seller(n));
    }
    const result = await useCase().execute(system, {});
    expect(result).toEqual({ ok: true, value: { done: total, failed: 0 } });
    expect(requests.every((row) => row.status === 'done')).toBe(true);
  });

  it('refuses an actor that is not the system', async () => {
    approved.set(`${market.marketId}|${seller(1)}`, 'UTC');
    request(seller(1));
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
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(asked).toEqual([]);
    expect(finished).toEqual([]);
  });
});
