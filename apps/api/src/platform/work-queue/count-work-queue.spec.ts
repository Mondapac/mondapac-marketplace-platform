import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import { countSellerWorkQueue, sessionSellerOf } from './count-work-queue';
import type { WorkQueueCountQuery } from './work-queue-count';

// The seller gate of the work-queue counts (dashboards upgrade, phase 1, seller tasks), on both
// Market fixtures: the seller comes from the session only, a customer and an admin acting as
// themselves are refused before any read, and a stopped dashboard, a failed preparation or a failed
// store answer access.unavailable.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const COUNT = { count: 2, overdue: 1, oldestAt: NOW.subtract({ hours: 3 }) };
const SELLER = id<'Seller'>(0xa3);

let units: { market: MarketContext; readOnly: boolean }[];
const unitOfWork = {
  run: (market: MarketContext, work: () => Promise<unknown>, options?: { readOnly?: boolean }) => {
    units.push({ market, readOnly: options?.readOnly === true });
    return work();
  },
} as unknown as UnitOfWork;

beforeEach(() => {
  units = [];
});

describe.each(TEST_MARKETS)('countSellerWorkQueue in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const actor = (population: 'admin' | 'seller' | 'customer'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1),
        sessionId: id(0xa2),
        sellerId: population === 'seller' ? SELLER : null,
      }),
    );
  const withActingAs = (own: CallContext): CallContext =>
    Object.assign(Object.create(Object.getPrototypeOf(own) as object) as object, own, {
      actor: { ...own.actor, actingAs: { sellerId: SELLER } },
    });
  const query = (signal: AbortSignal = new AbortController().signal): WorkQueueCountQuery => ({
    now: NOW,
    staleBefore: NOW.subtract({ hours: 48 }),
    signal,
  });
  const reads: Id<'Seller'>[] = [];
  const read = (_counts: null, sellerId: Id<'Seller'>) => {
    reads.push(sellerId);
    return Promise.resolve(COUNT);
  };

  beforeEach(() => {
    reads.length = 0;
  });

  it("counts for the session's seller in one read-only unit of the caller's Market", async () => {
    expect(
      await countSellerWorkQueue({ unitOfWork, counts: null }, actor('seller'), query(), read),
    ).toEqual(ok(COUNT));
    expect(reads).toEqual([SELLER]);
    expect(units).toEqual([{ market, readOnly: true }]);
  });

  it('allows a seller session that carries the acting-as marker (Login as Seller is a read)', async () => {
    expect(
      await countSellerWorkQueue(
        { unitOfWork, counts: null },
        withActingAs(actor('seller')),
        query(),
        read,
      ),
    ).toEqual(ok(COUNT));
    expect(reads).toEqual([SELLER]);
  });

  it('refuses a customer, an admin and an admin acting-as session without a seller, before any read', async () => {
    for (const context of [actor('customer'), actor('admin'), withActingAs(actor('admin'))]) {
      expect(
        await countSellerWorkQueue({ unitOfWork, counts: null }, context, query(), read),
      ).toEqual(err({ code: 'access.denied' }));
    }
    expect(sessionSellerOf(testCallContext(market, 'system'))).toBeNull();
    expect(reads).toHaveLength(0);
    expect(units).toHaveLength(0);
  });

  it('hands the prepared value to the read, and prepares outside the unit', async () => {
    const order: string[] = [];
    const answer = await countSellerWorkQueue(
      {
        unitOfWork: {
          run: (_m: MarketContext, work: () => Promise<unknown>) => {
            order.push('unit');
            return work();
          },
        } as unknown as UnitOfWork,
        counts: null,
      },
      actor('seller'),
      query(),
      (_counts, sellerId, zone: string) => {
        order.push(`read:${sellerId === SELLER ? 'seller' : 'other'}:${zone}`);
        return Promise.resolve(COUNT);
      },
      (sellerId) => {
        order.push(`prepare:${sellerId === SELLER ? 'seller' : 'other'}`);
        return Promise.resolve('Pacific/Auckland');
      },
    );
    expect(answer).toEqual(ok(COUNT));
    expect(order).toEqual(['prepare:seller', 'unit', 'read:seller:Pacific/Auckland']);
  });

  it('answers access.unavailable once stopped, when the preparation fails, or the store fails', async () => {
    const stopped = new AbortController();
    stopped.abort();
    const deps = { unitOfWork, counts: null };
    expect(await countSellerWorkQueue(deps, actor('seller'), query(stopped.signal), read)).toEqual(
      err({ code: 'access.unavailable' }),
    );
    const later = new AbortController();
    expect(
      await countSellerWorkQueue(deps, actor('seller'), query(later.signal), read, () => {
        later.abort();
        return Promise.resolve(undefined);
      }),
    ).toEqual(err({ code: 'access.unavailable' }));
    expect(
      await countSellerWorkQueue(deps, actor('seller'), query(), read, () =>
        Promise.reject(new Error('sellers down')),
      ),
    ).toEqual(err({ code: 'access.unavailable' }));
    expect(reads).toHaveLength(0);
    expect(
      await countSellerWorkQueue(deps, actor('seller'), query(), () =>
        Promise.reject(new Error('down')),
      ),
    ).toEqual(err({ code: 'access.unavailable' }));
  });
});
