import { err, money, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { SearchAssistantFacade } from '../../search';
import { FacadeBasketSources } from './facade-basket-sources';

const context = testCallContext(testMarketContext('AU', 'default'), 'anonymous');
const searching = (answer: Awaited<ReturnType<SearchAssistantFacade['searchProducts']>>) =>
  ({ searchProducts: () => Promise.resolve(answer) }) as unknown as SearchAssistantFacade;

describe('FacadeBasketSources', () => {
  it('maps a result to a candidate with its price', async () => {
    const sources = new FacadeBasketSources(
      searching(
        ok([
          {
            offerId: 'o1',
            productId: 'p1',
            sellerId: 's1',
            name: 'Rice',
            shortText: null,
            sellerName: 'Farm',
            price: money(500n, 'AUD'),
            regularPrice: null,
            taxInclusive: true,
            priceFrom: false,
          },
        ] as never),
      ),
      () => Promise.resolve('single-store'),
    );
    expect(await sources.candidates(context, 'rice')).toEqual(
      ok([
        {
          offerId: 'o1',
          productId: 'p1',
          sellerId: 's1',
          sellerName: 'Farm',
          name: 'Rice',
          price: money(500n, 'AUD'),
          priceFrom: false,
          taxInclusive: true,
        },
      ]),
    );
    expect(await sources.cartMode(context)).toBe('single-store');
  });

  it('treats a refused query as no results but a failed read as an error', async () => {
    const refused = new FacadeBasketSources(searching(err({ code: 'validation.failed' })), () =>
      Promise.resolve('multi-store'),
    );
    expect(await refused.candidates(context, 'x')).toEqual(ok([]));
    const down = new FacadeBasketSources(searching(err({ code: 'search.unavailable' })), () =>
      Promise.resolve('multi-store'),
    );
    expect(await down.candidates(context, 'rice')).toEqual(err({ code: 'unavailable' }));
  });

  it('answers multi-store when the cart mode cannot be read', async () => {
    const sources = new FacadeBasketSources(searching(ok([])), () =>
      Promise.reject(new Error('x')),
    );
    expect(await sources.cartMode(context)).toBe('multi-store');
  });
});
