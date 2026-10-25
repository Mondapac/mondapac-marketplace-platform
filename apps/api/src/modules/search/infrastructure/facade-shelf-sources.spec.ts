import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { MAX_BOUGHT_TOGETHER } from '../../ordering';
import type { OrderingRankingFacade } from '../../ordering';
import type { PricingSpecialsFacade } from '../../pricing';
import { BOUGHT_TOGETHER_DEPTH } from '../domain/shelf-query';
import { FacadeShelfSources } from './facade-shelf-sources';

const offer = (n: number): Id<'Offer'> => {
  const parsed = parseId<'Offer'>(
    `01990000-0000-7000-8000-${(0x1000 + n).toString(16).padStart(12, '0')}`,
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each(['AU', 'ZZ'] as const)(
  'FacadeShelfSources.boughtTogetherOfferIds in market %s',
  (code) => {
    const context: CallContext = testCallContext(
      testMarketContext(code, 'default'),
      'anonymous',
      'sources-0001-abc',
    );
    const sources = (behaviour: () => Promise<unknown>) => {
      const calls: unknown[][] = [];
      const ordering = {
        boughtTogether: (...args: unknown[]) => {
          calls.push(args);
          return behaviour();
        },
      } as unknown as OrderingRankingFacade;
      return { sut: new FacadeShelfSources(ordering, {} as PricingSpecialsFacade), calls };
    };

    it('answers the ids of an ok answer and passes the context, Offer and limit unchanged', async () => {
      const { sut, calls } = sources(() => Promise.resolve(ok([offer(2), offer(3)])));

      expect(await sut.boughtTogetherOfferIds(context, offer(1), 24)).toEqual([offer(2), offer(3)]);
      expect(calls).toEqual([[context, { offerId: offer(1), limit: 24 }]]);
      expect(calls[0]![0]).toBe(context);
    });

    it('answers null for an error answer', async () => {
      const { sut } = sources(() => Promise.resolve(err({ code: 'access.denied' })));

      expect(await sut.boughtTogetherOfferIds(context, offer(1), 24)).toBeNull();
    });

    it('answers null when the facade throws', async () => {
      const { sut } = sources(() => Promise.reject(new Error('down')));

      expect(await sut.boughtTogetherOfferIds(context, offer(1), 24)).toBeNull();
    });

    it('asks no more than ordering answers', () => {
      expect(BOUGHT_TOGETHER_DEPTH).toBeLessThanOrEqual(MAX_BOUGHT_TOGETHER);
    });
  },
);
