import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { CommissionPayoutsFacade } from '../../commission-payouts';
import { CommissionPayoutsSellerDisputeSignals } from './commission-payouts-seller-dispute-signals';

const SELLER = '01990000-0000-7000-8000-000000000a02' as Id<'Seller'>;

describe.each(['AU', 'ZZ'] as const)(
  'commission-payouts seller dispute signals in market %s',
  (code) => {
    const context: CallContext = testCallContext(testMarketContext(code, 'default'), 'system');
    const facade = (answer: unknown) => {
      const calls: [string, string][][] = [];
      const commissionPayouts = {
        sellerLostDisputes: (
          c: CallContext,
          _id: unknown,
          windows: readonly { from: Temporal.Instant; to: Temporal.Instant }[],
        ) => {
          expect(c).toBe(context);
          calls.push(windows.map((w) => [w.from.toString(), w.to.toString()]));
          return Promise.resolve(answer);
        },
      } as unknown as CommissionPayoutsFacade;
      return { signals: new CommissionPayoutsSellerDisputeSignals(commissionPayouts), calls };
    };
    const days = [Temporal.PlainDate.from('2026-11-09'), Temporal.PlainDate.from('2026-11-10')];

    it('asks once for the seller local days and returns the counters in order', async () => {
      const counts = [{ lost: 1 }, { lost: 0 }];
      const { signals, calls } = facade(ok(counts));

      expect(await signals.days(context, SELLER, days, 'Pacific/Auckland')).toEqual(counts);
      expect(calls).toEqual([
        [
          ['2026-11-08T11:00:00Z', '2026-11-09T11:00:00Z'],
          ['2026-11-09T11:00:00Z', '2026-11-10T11:00:00Z'],
        ],
      ]);
    });

    it('throws on any refusal so the rollup stores nothing for those days', async () => {
      const { signals } = facade(err({ code: 'access.denied' }));

      await expect(signals.days(context, SELLER, days, 'UTC')).rejects.toThrow('access.denied');
    });
  },
);
