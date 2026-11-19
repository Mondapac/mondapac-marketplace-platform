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
import type {
  SellerHealthRequest,
  SellerHealthRequestSource,
  SellerHealthRequestStore,
} from '../ports/seller-health-request.store';
import type { SellerHealthRoster } from '../ports/seller-health-roster';
import {
  RefreshOwnSellerHealth,
  SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS,
} from './refresh-own-seller-health.use-case';

// `sellers.refresh-own-seller-health` in memory, on both Market fixtures: it only queues, with
// source `seller`; a second click inside the cooldown is `request.throttled` with the seconds left;
// an admin's request never locks the seller; the cooldown ends on time; an unapproved seller is
// `file.not-found`; only a seller session passes; the gate refuses an actor that is not admitted.
// The store is covered against PostgreSQL by test/db/sellers-health-requests.db-spec.ts.

const NOW = Temporal.Instant.from('2026-11-10T12:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const denyAll: AuthorisationCheck = {
  check: () => Promise.resolve({ allowed: false, denial: { code: 'access.denied' } }),
};

describe.each(['AU', 'ZZ'] as const)('sellers.refresh-own-seller-health (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);
  const mine = ids.next<'Seller'>();
  const unapproved = ids.next<'Seller'>();
  let stored: (SellerHealthRequest & { byAccountId: Id<'Account'> })[];
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
      one: (_m, seller) =>
        Promise.resolve(seller === mine ? { sellerId: seller, zone: 'UTC' } : null),
    };
    const healthRequests = {
      enqueue: (
        _m: MarketContext,
        request: {
          id: Id;
          sellerId: Id<'Seller'>;
          source: SellerHealthRequestSource;
          byAccountId: Id<'Account'>;
          at: Temporal.Instant;
        },
      ) => {
        if (stored.some((r) => r.sellerId === request.sellerId && r.status === 'pending')) {
          return Promise.resolve({ queued: false });
        }
        stored.push({
          id: request.id,
          sellerId: request.sellerId,
          source: request.source,
          requestedAt: request.at,
          status: 'pending',
          byAccountId: request.byAccountId,
        });
        return Promise.resolve({ queued: true });
      },
      latest: (_m: MarketContext, seller: Id<'Seller'>, source?: SellerHealthRequestSource) =>
        Promise.resolve(
          [...stored]
            .reverse()
            .find((r) => r.sellerId === seller && (source === undefined || r.source === source)) ??
            null,
        ),
    } as unknown as SellerHealthRequestStore;
    return new RefreshOwnSellerHealth(createUseCaseGate(markets, authorisation), {
      unitOfWork,
      healthRoster,
      healthRequests,
      ids,
      clock,
    });
  };

  const sellerContext = (sellerId: Id<'Seller'> = mine) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
  const finish = () => {
    for (const r of stored) (r as { status: string }).status = 'done';
  };

  beforeEach(() => {
    clock.set(NOW);
    stored = [];
    units = [];
    unitFails = false;
  });

  it('queues one request for the acting seller with source seller', async () => {
    const context = sellerContext();
    const result = await useCase().execute(context, {});
    expect(result).toEqual({ ok: true, value: { status: 'queued' } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sellerId: mine, source: 'seller', requestedAt: NOW });
    expect(units).toEqual([{ readOnly: false }]);
  });

  it('refuses a second click inside the cooldown with the seconds left, adding nothing', async () => {
    await useCase().execute(sellerContext(), {});
    finish();
    clock.set(NOW.add({ minutes: 5 }));
    const result = await useCase().execute(sellerContext(), {});
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'request.throttled',
        retryAfterSeconds: SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS - 5 * 60,
      },
    });
    expect(stored).toHaveLength(1);
  });

  it('lets the next click through once the cooldown is over, to the second', async () => {
    await useCase().execute(sellerContext(), {});
    finish();
    clock.set(NOW.add({ seconds: SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS - 1 }));
    const early = await useCase().execute(sellerContext(), {});
    expect(early).toEqual({
      ok: false,
      error: { code: 'request.throttled', retryAfterSeconds: 1 },
    });
    clock.set(NOW.add({ seconds: SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS }));
    const after = await useCase().execute(sellerContext(), {});
    expect(after).toEqual({ ok: true, value: { status: 'queued' } });
    expect(stored).toHaveLength(2);
  });

  it('is not locked by an admin request, and answers already-queued while that one waits', async () => {
    stored.push({
      id: ids.next(),
      sellerId: mine,
      source: 'admin',
      requestedAt: NOW,
      status: 'pending',
      byAccountId: ids.next<'Account'>(),
    });
    const waiting = await useCase().execute(sellerContext(), {});
    expect(waiting).toEqual({ ok: true, value: { status: 'already-queued' } });
    finish();
    const after = await useCase().execute(sellerContext(), {});
    expect(after).toEqual({ ok: true, value: { status: 'queued' } });
  });

  it('answers file.not-found for a seller without an approved file, queuing nothing', async () => {
    const result = await useCase().execute(sellerContext(unapproved), {});
    expect(result).toEqual({ ok: false, error: { code: 'file.not-found' } });
    expect(stored).toEqual([]);
  });

  it('refuses a session that is not a seller', async () => {
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    expect(await useCase().execute(admin, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(stored).toEqual([]);
  });

  it('answers sellers.unavailable when the unit fails', async () => {
    unitFails = true;
    const result = await useCase().execute(sellerContext(), {});
    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });

  it('refuses when the gate does not admit the actor, reading nothing', async () => {
    const result = await useCase(denyAll).execute(sellerContext(), {});
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(units).toEqual([]);
  });
});
