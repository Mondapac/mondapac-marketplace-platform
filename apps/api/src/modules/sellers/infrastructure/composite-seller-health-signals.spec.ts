import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { CompositeSellerHealthSignals } from './composite-seller-health-signals';
import { LateBoundSellerHealthSignals } from './late-bound-seller-health-signals';

const SELLER = '01990000-0000-7000-8000-0000000000a1' as Id<'Seller'>;
const DAYS = [Temporal.PlainDate.from('2026-11-09'), Temporal.PlainDate.from('2026-11-10')];

describe.each(['AU', 'ZZ'] as const)('seller health signals (%s)', (code) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'system');

  const feeds = (short = false) => {
    const calls: string[] = [];
    return {
      calls,
      composite: new CompositeSellerHealthSignals(
        {
          days: () => {
            calls.push('orders');
            return Promise.resolve([
              { paid: 4, ready: 3, lateReady: 1 },
              { paid: 5, ready: 5, lateReady: 0 },
            ]);
          },
        },
        {
          days: () => {
            calls.push('reviews');
            return Promise.resolve([
              { reviews: 2, starsSum: 9 },
              { reviews: 0, starsSum: 0 },
            ]);
          },
        },
        {
          days: () => {
            calls.push('disputes');
            return Promise.resolve(short ? [{ lost: 1 }] : [{ lost: 0 }, { lost: 2 }]);
          },
        },
      ),
    };
  };

  it('lays the three answers side by side, one read of each', async () => {
    const { composite, calls } = feeds();
    expect(await composite.days(context, SELLER, DAYS, 'UTC')).toEqual([
      {
        day: DAYS[0],
        paidOrders: 4,
        readyOrders: 3,
        lateReadyOrders: 1,
        lostDisputes: 0,
        reviewsApproved: 2,
        ratingStarsSum: 9,
      },
      {
        day: DAYS[1],
        paidOrders: 5,
        readyOrders: 5,
        lateReadyOrders: 0,
        lostDisputes: 2,
        reviewsApproved: 0,
        ratingStarsSum: 0,
      },
    ]);
    expect(calls).toEqual(['orders', 'reviews', 'disputes']);
  });

  it('refuses a feed that answers the wrong number of days', async () => {
    await expect(feeds(true).composite.days(context, SELLER, DAYS, 'UTC')).rejects.toThrow(
      'wrong number of days',
    );
  });

  it('refuses to read until the feeds are bound, binds once, then reads', async () => {
    const late = new LateBoundSellerHealthSignals();
    await expect(late.days(context, SELLER, DAYS, 'UTC')).rejects.toThrow('not bound');
    const { composite } = feeds();
    late.bind(composite);
    expect(await late.days(context, SELLER, DAYS, 'UTC')).toHaveLength(2);
    expect(() => late.bind(composite)).toThrow('already bound');
  });
});
