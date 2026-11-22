import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
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
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import { ORDERING_SELLER_ORDER_VIEW } from '../contracts/permissions';
import type { SellerZones } from './ports/seller-zones';
import type { WorkQueueCountReader } from './ports/work-queue-count.reader';
import { CountSellerLateOrders } from './use-cases/count-seller-late-orders.use-case';
import { CountSellerPickupsUncollected } from './use-cases/count-seller-pickups-uncollected.use-case';
import {
  CountSellerToShipToday,
  localDayOf,
} from './use-cases/count-seller-to-ship-today.use-case';

// The ordering seller tasks of the dashboard (dashboards upgrade, phase 1, PR 6), on both Market
// fixtures: the key `ordering.seller-order.view` (denied while not approved), the session's seller
// passed to the reader (never another), a customer and an admin acting as themselves refused,
// the seller's local day, and `access.unavailable` once stopped or when a read fails.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 48 });
const COUNT = { count: 3, overdue: 1, oldestAt: NOW.subtract({ hours: 4 }) };
const SELLER = id<'Seller'>(0xa3);
const ZONE = 'Pacific/Auckland';

type Read = { method: string; market: MarketContext; sellerId: Id<'Seller'>; args: unknown[] };

let declarations: AccessDeclaration[];
let reads: Read[];
let zoneCalls: Id<'Seller'>[];
let failing: boolean;
let zoneFailing: boolean;

const gate = createUseCaseGate(markets, {
  check: (_context, declaration) => {
    declarations.push(declaration);
    return Promise.resolve({ allowed: true as const });
  },
});
const unitOfWork = {
  run: (_market: MarketContext, work: () => Promise<unknown>, options?: { readOnly?: boolean }) => {
    if (options?.readOnly !== true) throw new Error('expected a read-only unit');
    return work();
  },
} as unknown as UnitOfWork;
const record = (read: Read) => {
  reads.push(read);
  return failing ? Promise.reject(new Error('down')) : Promise.resolve(COUNT);
};
const admin = () => Promise.reject(new Error('not a seller count'));
const counts: WorkQueueCountReader = {
  lateDeliveries: admin,
  pendingRefunds: admin,
  failedPayments: admin,
  sellerLateOrders: (market, sellerId, now, overdueBefore) =>
    record({ method: 'late', market, sellerId, args: [now, overdueBefore] }),
  sellerToShipToday: (market, sellerId, now, dayStart, dayEnd) =>
    record({ method: 'to-ship', market, sellerId, args: [now, dayStart, dayEnd] }),
  sellerPickupsUncollected: (market, sellerId, staleBefore) =>
    record({ method: 'pickups', market, sellerId, args: [staleBefore] }),
};
const zones: SellerZones = {
  zoneOf: (_context, sellerId) => {
    zoneCalls.push(sellerId);
    return zoneFailing ? Promise.reject(new Error('sellers down')) : Promise.resolve(ZONE);
  },
};
const DAY = localDayOf(NOW, ZONE);
const USE_CASES = [
  {
    method: 'late',
    useCase: new CountSellerLateOrders(gate, { unitOfWork, counts }),
    args: [NOW, STALE],
  },
  {
    method: 'to-ship',
    useCase: new CountSellerToShipToday(gate, { unitOfWork, counts, zones }),
    args: [NOW, DAY.start, DAY.end],
  },
  {
    method: 'pickups',
    useCase: new CountSellerPickupsUncollected(gate, { unitOfWork, counts }),
    args: [STALE],
  },
];

beforeEach(() => {
  declarations = [];
  reads = [];
  zoneCalls = [];
  failing = false;
  zoneFailing = false;
});

describe('localDayOf', () => {
  it("is the seller's calendar day, with a daylight-saving day of 23 hours", () => {
    // 01:00 UTC on 22 Nov 2026 is 14:00 on 22 Nov in Auckland (UTC+13 in summer).
    expect(DAY.start.toString()).toBe('2026-11-21T11:00:00Z');
    expect(DAY.end.toString()).toBe('2026-11-22T11:00:00Z');
    const spring = localDayOf(Temporal.Instant.from('2026-09-27T05:00:00Z'), ZONE);
    expect(spring.end.since(spring.start).total('hours')).toBe(23);
  });
});

describe.each(TEST_MARKETS)('ordering seller tasks in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const actor = (population: 'admin' | 'seller' | 'customer', sellerId = SELLER): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1),
        sessionId: id(0xa2),
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );
  const query = (signal: AbortSignal = new AbortController().signal): WorkQueueCountQuery => ({
    now: NOW,
    staleBefore: STALE,
    signal,
  });

  describe.each(USE_CASES)('$method', ({ method, useCase, args }) => {
    it("counts behind ordering.seller-order.view for the session's seller only", async () => {
      expect(await useCase.execute(actor('seller'), query())).toEqual(ok(COUNT));
      expect(declarations).toEqual([
        expect.objectContaining({
          rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
          whenSellerNotApproved: 'deny',
        }),
      ]);
      expect(reads).toEqual([{ method, market, sellerId: SELLER, args }]);
      // Another seller's session reads that seller's own orders, never the first one's.
      const other = id<'Seller'>(0xb3);
      await useCase.execute(actor('seller', other), query());
      expect(reads[1]?.sellerId).toBe(other);
    });

    it('refuses a customer and an admin acting as themselves, before any read', async () => {
      expect(await useCase.execute(actor('customer'), query())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await useCase.execute(actor('admin'), query())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(reads).toHaveLength(0);
      expect(zoneCalls).toHaveLength(0);
    });

    it('answers access.unavailable once the dashboard stopped waiting, or the store fails', async () => {
      const stopped = new AbortController();
      stopped.abort();
      expect(await useCase.execute(actor('seller'), query(stopped.signal))).toEqual(
        err({ code: 'access.unavailable' }),
      );
      expect(reads).toHaveLength(0);
      failing = true;
      expect(await useCase.execute(actor('seller'), query())).toEqual(
        err({ code: 'access.unavailable' }),
      );
    });
  });

  it("reads the session seller's zone before the unit, and fails closed without it", async () => {
    const toShip = USE_CASES[1]!.useCase;
    await toShip.execute(actor('seller'), query());
    expect(zoneCalls).toEqual([SELLER]);
    zoneFailing = true;
    reads = [];
    expect(await toShip.execute(actor('seller'), query())).toEqual(
      err({ code: 'access.unavailable' }),
    );
    expect(reads).toHaveLength(0);
  });
});
