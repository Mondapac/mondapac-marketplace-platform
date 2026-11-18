import { err, money, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { SearchAssistantFacade } from '../../search';
import { FacadeBasketSources } from './facade-basket-sources';

const context = testCallContext(testMarketContext('AU', 'default'), 'anonymous');
const searching = (answer: Awaited<ReturnType<SearchAssistantFacade['searchProducts']>>) =>
  ({ searchProducts: () => Promise.resolve(answer) }) as unknown as SearchAssistantFacade;

const noUnits = () => Promise.resolve(err({ code: 'cart.offer-not-purchasable' as const }));

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
      noUnits,
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
    const refused = new FacadeBasketSources(
      searching(err({ code: 'validation.failed' })),
      () => Promise.resolve('multi-store'),
      noUnits,
    );
    expect(await refused.candidates(context, 'x')).toEqual(ok([]));
    const down = new FacadeBasketSources(
      searching(err({ code: 'search.unavailable' })),
      () => Promise.resolve('multi-store'),
      noUnits,
    );
    expect(await down.candidates(context, 'rice')).toEqual(err({ code: 'unavailable' }));
  });

  it('answers multi-store when the cart mode cannot be read', async () => {
    const sources = new FacadeBasketSources(
      searching(ok([])),
      () => Promise.reject(new Error('x')),
      noUnits,
    );
    expect(await sources.cartMode(context)).toBe('multi-store');
  });

  it('maps the sell units of an offer, and answers unavailable when they cannot be read', async () => {
    const unit = { variantId: 'v1', unitPrice: money(500n, 'AUD'), maxQuantity: 7 };
    const reading = new FacadeBasketSources(
      searching(ok([])),
      () => Promise.resolve('multi-store'),
      () => Promise.resolve(ok([unit])),
    );
    expect(await reading.units(context, 'o1')).toEqual(ok([unit]));
    const refused = new FacadeBasketSources(
      searching(ok([])),
      () => Promise.resolve('multi-store'),
      noUnits,
    );
    expect(await refused.units(context, 'o1')).toEqual(err({ code: 'unavailable' }));
    const failing = new FacadeBasketSources(
      searching(ok([])),
      () => Promise.resolve('multi-store'),
      () => Promise.reject(new Error('x')),
    );
    expect(await failing.units(context, 'o1')).toEqual(err({ code: 'unavailable' }));
  });
});
