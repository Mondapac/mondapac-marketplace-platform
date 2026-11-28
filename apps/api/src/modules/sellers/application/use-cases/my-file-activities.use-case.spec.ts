import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
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
import type { StoredActivityAssignment } from '../../domain/seller-business-activities';
import type { BusinessActivityDirectory } from '../ports/business-activity-directory';
import type {
  SellerActivityRequestRepository,
  StoredActivityRequest,
} from '../ports/seller-activity-request.repository';
import type { SellerBusinessActivityRepository } from '../ports/seller-business-activity.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import { MyFileActivitiesRead } from './my-file-activities-read.use-case';
import { MyFileActivitiesSave } from './my-file-activities-save.use-case';

// The seller's own request for business activities (BUG-012 step 2) in memory, on both Market
// fixtures. The table, its CHECKs and grants are covered by test/db/seller-activity-requests.db-spec.ts.

const START = Temporal.Instant.from('2026-11-28T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
type ActivityId = Id<'BusinessActivity'>;

const key = (market: MarketContext, sellerId: string): string => `${market.marketId}|${sellerId}`;

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const requests = new Map<string, StoredActivityRequest & { by: Id<'Account'> }>();
  let saves = 0;
  const activityRequests: SellerActivityRequestRepository = {
    find: (market, sellerId) => Promise.resolve(requests.get(key(market, sellerId)) ?? null),
    save: (market, sellerId, next) => {
      saves += 1;
      requests.set(key(market, sellerId), {
        mainActivityId: next.mainActivityId,
        extraActivityIds: next.extraActivityIds,
        requestedAt: next.at,
        by: next.by,
      });
      return Promise.resolve();
    },
  };
  const assigned = new Map<string, StoredActivityAssignment>();
  const businessActivities = {
    find: (market: MarketContext, sellerIds: readonly Id<'Seller'>[]) => {
      const found = new Map<Id<'Seller'>, StoredActivityAssignment>();
      for (const id of sellerIds) {
        const row = assigned.get(key(market, id));
        if (row !== undefined) found.set(id, row);
      }
      return Promise.resolve(found);
    },
  } as unknown as SellerBusinessActivityRepository;
  const files = {
    findById: (market: MarketContext, sellerId: Id<'Seller'>) =>
      Promise.resolve(sellers.has(key(market, sellerId)) ? {} : null),
  } as unknown as SellerFileRepository;
  const sellers = new Set<string>();
  const active = new Set<string>();
  let directoryDown = false;
  const asked: ActivityId[][] = [];
  const activityDirectory: BusinessActivityDirectory = {
    activeIds: (_context, requested) => {
      asked.push([...requested]);
      if (directoryDown) {
        return Promise.resolve(err({ code: 'business-activity-directory.unavailable' }));
      }
      return Promise.resolve(ok(new Set(requested.filter((id) => active.has(id)))));
    },
  };
  let over = false;
  const counters = {
    reserve: (_m: MarketContext, list: readonly { limit: { kind: string } }[]) =>
      Promise.resolve(
        list.map((c) => ({
          kind: c.limit.kind,
          count: over ? 1_000_000 : 1,
          windowStartedAt: START,
        })),
      ),
  } as never;
  const counterKeys = { keyOf: () => new Uint8Array(32) };
  const authorisation: AuthorisationCheck = {
    check: () => Promise.resolve({ allowed: true }),
  };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  return {
    clock,
    ids,
    requests,
    assigned,
    sellers,
    active,
    asked,
    saves: () => saves,
    breakDirectory: () => void (directoryDown = true),
    throttle: () => void (over = true),
    read: new MyFileActivitiesRead(gate, {
      unitOfWork,
      files,
      activityRequests,
      businessActivities,
    }),
    save: new MyFileActivitiesSave(gate, {
      unitOfWork,
      files,
      activityRequests,
      activityDirectory,
      counters,
      counterKeys,
      clock,
    }),
  };
}
type Setup = ReturnType<typeof setUp>;

const as = (
  t: Setup,
  code: string,
  population: 'seller' | 'admin',
  sellerId: Id<'Seller'> | null,
): CallContext => {
  const market = testMarketContext(code, 'default');
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population,
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );
};

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

describe.each([['AU'], ['ZZ']])('the seller own request for activities in %s', (code) => {
  const market = testMarketContext(code, 'default');

  function withSeller() {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.sellers.add(key(market, sellerId));
    const [a, b, c] = [
      t.ids.next<'BusinessActivity'>(),
      t.ids.next<'BusinessActivity'>(),
      t.ids.next<'BusinessActivity'>(),
    ];
    for (const id of [a, b, c]) t.active.add(id);
    return { t, sellerId, a, b, c, own: as(t, code, 'seller', sellerId) };
  }

  it('reads as nothing asked and nothing assigned before the first save', async () => {
    const { t, own } = withSeller();
    expect(await t.read.execute(own, {})).toEqual(
      ok({ requested: null, assigned: { mainActivityId: null, extraActivityIds: [] } }),
    );
  });

  it('saves a request without touching what the seller carries, and reads it back', async () => {
    const { t, sellerId, a, b, c, own } = withSeller();
    const saved = await t.save.execute(own, {
      body: { mainActivityId: a, extraActivityIds: [c, b] },
    });
    expect(saved).toEqual(
      ok({ mainActivityId: a, extraActivityIds: [b, c].sort(), changed: true }),
    );
    expect(t.asked).toEqual([[a, ...[b, c].sort()]]);
    expect(t.assigned.size).toBe(0);
    const view = await t.read.execute(own, {});
    expect(view).toEqual(
      ok({
        requested: {
          mainActivityId: a,
          extraActivityIds: [b, c].sort(),
          requestedAt: START.toString(),
        },
        assigned: { mainActivityId: null, extraActivityIds: [] },
      }),
    );
    expect(t.requests.get(key(market, sellerId))?.by).toBe(
      own.actor.kind === 'authenticated' ? own.actor.accountId : '',
    );
  });

  it('writes nothing when the same set is saved again, and replaces a different one', async () => {
    const { t, a, b, own } = withSeller();
    await t.save.execute(own, { body: { mainActivityId: a, extraActivityIds: [] } });
    const again = await t.save.execute(own, { body: { mainActivityId: a, extraActivityIds: [] } });
    expect(again).toEqual(ok({ mainActivityId: a, extraActivityIds: [], changed: false }));
    expect(t.saves()).toBe(1);
    await t.save.execute(own, { body: { mainActivityId: b, extraActivityIds: [a] } });
    expect(t.saves()).toBe(2);
  });

  it('refuses a malformed body before asking catalog or writing', async () => {
    const { t, a, own } = withSeller();
    for (const body of [
      null,
      [],
      {},
      { mainActivityId: a },
      { mainActivityId: 'x', extraActivityIds: [] },
      { mainActivityId: a, extraActivityIds: [a] },
      { mainActivityId: a, extraActivityIds: [], sellerId: 'other' },
      { mainActivityId: a, extraActivityIds: [], reason: 'x' },
    ]) {
      const result = await t.save.execute(own, { body });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('validation.failed');
    }
    expect(t.asked).toEqual([]);
    expect(t.saves()).toBe(0);
  });

  it('refuses an activity that is not active, naming the field only', async () => {
    const { t, a, b, own } = withSeller();
    const stranger = t.ids.next<'BusinessActivity'>();
    const result = await t.save.execute(own, {
      body: { mainActivityId: stranger, extraActivityIds: [a, stranger === b ? a : b] },
    });
    expect(result).toEqual(
      err({
        code: 'validation.failed',
        fields: [{ path: 'mainActivityId', code: 'not-active' }],
      }),
    );
    expect(t.saves()).toBe(0);
  });

  it('fails closed when catalog cannot answer', async () => {
    const { t, a, own } = withSeller();
    t.breakDirectory();
    expect(
      await t.save.execute(own, { body: { mainActivityId: a, extraActivityIds: [] } }),
    ).toEqual(err({ code: 'sellers.unavailable' }));
    expect(t.saves()).toBe(0);
  });

  it('refuses a file that does not exist, and a seller of another Market', async () => {
    const t = setUp();
    const ghost = t.ids.next<'Seller'>();
    const a = t.ids.next<'BusinessActivity'>();
    t.active.add(a);
    const body = { mainActivityId: a, extraActivityIds: [] };
    expect(await t.save.execute(as(t, code, 'seller', ghost), { body })).toEqual(
      err({ code: 'file.not-found' }),
    );
    expect(await t.read.execute(as(t, code, 'seller', ghost), {})).toEqual(
      err({ code: 'file.not-found' }),
    );
  });

  it('is for the seller only: an admin and an anonymous caller', async () => {
    const { t, a, sellerId } = withSeller();
    const body = { mainActivityId: a, extraActivityIds: [] };
    for (const context of [as(t, code, 'admin', null), testCallContext(market, 'anonymous')]) {
      const saved = await t.save.execute(context, { body });
      const read = await t.read.execute(context, {});
      expect(saved.ok).toBe(false);
      expect(read.ok).toBe(false);
    }
    expect(t.requests.has(key(market, sellerId))).toBe(false);
  });

  it('never takes the seller from the request: another seller keeps its own request', async () => {
    const { t, sellerId, a, own } = withSeller();
    const other = t.ids.next<'Seller'>();
    t.sellers.add(key(market, other));
    await t.save.execute(own, { body: { mainActivityId: a, extraActivityIds: [] } });
    const view = await t.read.execute(as(t, code, 'seller', other), {});
    expect(view).toEqual(
      ok({ requested: null, assigned: { mainActivityId: null, extraActivityIds: [] } }),
    );
    expect(t.requests.has(key(market, sellerId))).toBe(true);
  });

  it('is throttled before any read or write', async () => {
    const { t, a, own } = withSeller();
    t.throttle();
    const result = await t.save.execute(own, {
      body: { mainActivityId: a, extraActivityIds: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('request.throttled');
    expect(t.asked).toEqual([]);
  });
});
