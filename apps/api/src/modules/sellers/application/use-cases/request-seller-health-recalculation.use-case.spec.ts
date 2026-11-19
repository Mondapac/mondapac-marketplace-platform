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
import type { SellerHealthRequestStore } from '../ports/seller-health-request.store';
import type { SellerHealthRoster } from '../ports/seller-health-roster';
import { RequestSellerHealthRecalculation } from './request-seller-health-recalculation.use-case';

// `sellers.request-seller-health-recalculation` in memory, on both Market fixtures: it only queues
// (it never measures), a second click adds nothing, an unknown, unapproved or foreign seller is
// `file.not-found`, only an admin session passes, and the gate refuses an actor without the key.
// The store is covered against PostgreSQL by test/db/sellers-health-requests.db-spec.ts.

const NOW = Temporal.Instant.from('2026-11-10T12:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const denyAll: AuthorisationCheck = {
  check: () => Promise.resolve({ allowed: false, denial: { code: 'access.denied' } }),
};

describe.each(['AU', 'ZZ'] as const)('sellers.request-seller-health-recalculation (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);
  const mine = ids.next<'Seller'>();
  const unapproved = ids.next<'Seller'>();
  const foreign = ids.next<'Seller'>();
  let pending: Set<string>;
  let written: {
    market: string;
    sellerId: Id<'Seller'>;
    source: string;
    by: Id<'Account'>;
    at: string;
  }[];
  let units: { readOnly: boolean }[];
  let unitFails: boolean;

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
      // Only `mine` is approved, and only in this Market; `foreign` belongs to the other one.
      one: (m, seller) =>
        Promise.resolve(
          seller === mine && m.marketId === market.marketId
            ? { sellerId: seller, zone: 'UTC' }
            : null,
        ),
    };
    const healthRequests = {
      enqueue: (
        m: MarketContext,
        request: {
          sellerId: Id<'Seller'>;
          source: string;
          byAccountId: Id<'Account'>;
          at: Temporal.Instant;
        },
      ) => {
        const key = `${m.marketId}|${request.sellerId}`;
        if (pending.has(key)) return Promise.resolve({ queued: false });
        pending.add(key);
        written.push({
          market: m.marketId,
          sellerId: request.sellerId,
          source: request.source,
          by: request.byAccountId,
          at: request.at.toString(),
        });
        return Promise.resolve({ queued: true });
      },
    } as unknown as SellerHealthRequestStore;
    return new RequestSellerHealthRecalculation(createUseCaseGate(markets, authorisation), {
      unitOfWork,
      healthRoster,
      healthRequests,
      ids,
      clock,
    });
  };

  const admin = testAuthenticatedActor(market, {
    population: 'admin',
    accountId: ids.next<'Account'>(),
    sessionId: ids.next<'Session'>(),
    sellerId: null,
  });
  const adminContext = testCallContext(market, admin);

  beforeEach(() => {
    pending = new Set();
    written = [];
    units = [];
    unitFails = false;
  });

  it('queues one request for an approved seller, as the admin, and measures nothing', async () => {
    const result = await useCase().execute(adminContext, { sellerId: mine });
    expect(result).toEqual({ ok: true, value: { status: 'queued' } });
    expect(written).toEqual([
      {
        market: market.marketId,
        sellerId: mine,
        source: 'admin',
        by: admin.accountId,
        at: NOW.toString(),
      },
    ]);
    expect(units).toEqual([{ readOnly: false }]);
  });

  it('adds nothing for a second click while a request waits', async () => {
    const first = await useCase().execute(adminContext, { sellerId: mine });
    const second = await useCase().execute(adminContext, { sellerId: mine });
    expect(first).toEqual({ ok: true, value: { status: 'queued' } });
    expect(second).toEqual({ ok: true, value: { status: 'already-queued' } });
    expect(written).toHaveLength(1);
  });

  it('answers file.not-found for an unapproved, foreign or malformed seller, queuing nothing', async () => {
    for (const sellerId of [unapproved, foreign, 'not-an-id', '', undefined as unknown as string]) {
      const result = await useCase().execute(adminContext, { sellerId });
      expect(result).toEqual({ ok: false, error: { code: 'file.not-found' } });
    }
    // The other Market's admin cannot reach a seller of this one.
    const otherAdmin = testAuthenticatedActor(other, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    });
    const crossed = await useCase().execute(testCallContext(other, otherAdmin), { sellerId: mine });
    expect(crossed).toEqual({ ok: false, error: { code: 'file.not-found' } });
    expect(written).toEqual([]);
  });

  it('refuses a seller session, queuing nothing', async () => {
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: mine,
      }),
    );
    const result = await useCase().execute(seller, { sellerId: mine });
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(written).toEqual([]);
  });

  it('is refused by the gate when the actor lacks sellers.seller-health.recalculate', async () => {
    const result = await useCase(denyAll).execute(adminContext, { sellerId: mine });
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(written).toEqual([]);
    expect(units).toEqual([]);
  });

  it('answers sellers.unavailable when the unit fails', async () => {
    unitFails = true;
    const result = await useCase().execute(adminContext, { sellerId: mine });
    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });
});
