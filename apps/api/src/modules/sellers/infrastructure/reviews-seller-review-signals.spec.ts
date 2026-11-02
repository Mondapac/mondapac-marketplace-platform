import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { ReviewsFacade } from '../../reviews';
import { ReviewsFacadeSellerReviewSignals } from './reviews-seller-review-signals';

const SELLER = '01990000-0000-7000-8000-000000000a01' as Id<'Seller'>;

describe.each(['AU', 'ZZ'] as const)('reviews seller review signals in market %s', (code) => {
  const context: CallContext = testCallContext(testMarketContext(code, 'default'), 'system');
  const facade = (answer: unknown) => {
    const calls: [string, string][] = [];
    const reviews = {
      sellerReviewCount: (
        c: CallContext,
        _id: unknown,
        from: Temporal.Instant,
        to: Temporal.Instant,
      ) => {
        expect(c).toBe(context);
        calls.push([from.toString(), to.toString()]);
        return Promise.resolve(answer);
      },
    } as unknown as ReviewsFacade;
    return { signals: new ReviewsFacadeSellerReviewSignals(reviews), calls };
  };
  const day = Temporal.PlainDate.from('2026-11-10');

  it('asks for the seller local day and returns the counters', async () => {
    const { signals, calls } = facade(ok({ reviews: 3, starsSum: 13 }));

    expect(await signals.day(context, SELLER, day, 'Australia/Brisbane')).toEqual({
      reviews: 3,
      starsSum: 13,
    });
    expect(calls).toEqual([['2026-11-09T14:00:00Z', '2026-11-10T14:00:00Z']]);
  });

  it('answers zeros while reviews are off and throws on any other refusal', async () => {
    const off = facade(err({ code: 'reviews.disabled' }));
    const down = facade(err({ code: 'reviews.unavailable' }));

    expect(await off.signals.day(context, SELLER, day, 'UTC')).toEqual({ reviews: 0, starsSum: 0 });
    await expect(down.signals.day(context, SELLER, day, 'UTC')).rejects.toThrow('unavailable');
  });
});
