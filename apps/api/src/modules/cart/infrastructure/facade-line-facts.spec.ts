import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { CatalogFacade, OfferSellUnits } from '../../catalog';
import type { InventoryFacade, SellUnitAvailability } from '../../inventory';
import type { EffectivePrice, PricingFacade } from '../../pricing';
import type { SellersFacade } from '../../sellers';
import { verdictKey } from '../application/ports/line-facts';
import { FacadeLineFacts } from './facade-line-facts';

// How the four facades' answers become a verdict per sell unit (cart design 3.2, 6.2): the order
// of the checks, the reason of each refusal, and fail-closed when a facade fails or throws.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OFFER = id<'Offer'>(1);
const VARIANT = id<'Variant'>(2);
const SELLER = id<'Seller'>(3);
const ref = { offerId: OFFER, variantId: VARIANT };
const key = verdictKey(ref);

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('cart line facts in market %s', (code, currency) => {
  const context = testCallContext(
    testMarketContext(code, 'default'),
    'anonymous',
    'facts-0001-abcd',
  );
  const published: OfferSellUnits = {
    sellerId: SELLER,
    productId: id<'Product'>(4),
    status: 'published',
    listed: true,
    sellUnits: [{ variantId: VARIANT, state: 'published' }],
  };
  const price: EffectivePrice = {
    price: money(1999n, currency),
    taxInclusive: true,
    recordId: id<'RegularPriceRecord'>(5),
  };
  const stock: SellUnitAvailability = { sellable: 4, status: 'low', onlyLeft: 4 };

  function build(
    over: {
      offer?: OfferSellUnits | null;
      eligible?: boolean | 'fail' | 'throw';
      price?: EffectivePrice | null | 'fail';
      stock?: SellUnitAvailability | null | 'fail';
      catalog?: 'fail';
    } = {},
  ) {
    const offer = over.offer === undefined ? published : over.offer;
    const calls: string[] = [];
    const catalog = {
      offerSellUnits: () => {
        calls.push('catalog');
        return Promise.resolve(
          over.catalog === 'fail'
            ? err({ code: 'access.denied' } as never)
            : ok(new Map(offer === null ? [] : [[OFFER, offer]])),
        );
      },
    } as unknown as CatalogFacade;
    const sellers = {
      sellingEligibility: () => {
        calls.push('sellers');
        if (over.eligible === 'throw') return Promise.reject(new Error('down'));
        if (over.eligible === 'fail')
          return Promise.resolve(err({ code: 'access.denied' } as never));
        return Promise.resolve(ok(new Map([[SELLER, { eligible: over.eligible ?? true }]])));
      },
    } as unknown as SellersFacade;
    const pricing = {
      effectivePrices: () => {
        calls.push('pricing');
        if (over.price === 'fail') return Promise.resolve(err({ code: 'access.denied' } as never));
        const value = over.price === undefined ? price : over.price;
        return Promise.resolve(ok(new Map(value === null ? [] : [[key, value]])));
      },
    } as unknown as PricingFacade;
    const inventory = {
      availability: () => {
        calls.push('inventory');
        if (over.stock === 'fail') return Promise.resolve(err({ code: 'access.denied' } as never));
        const value = over.stock === undefined ? stock : over.stock;
        return Promise.resolve(ok(new Map(value === null ? [] : [[key, value]])));
      },
    } as unknown as InventoryFacade;
    return { facts: new FacadeLineFacts(catalog, sellers, pricing, inventory), calls };
  }
  const verdict = async (over?: Parameters<typeof build>[0]) =>
    (await build(over).facts.evaluate(context, [ref])).get(key);

  it('is buyable with the price, the tax flag, the seller and the stock state', async () => {
    expect(await verdict()).toEqual({
      state: 'buyable',
      reason: null,
      sellerId: SELLER,
      unitPrice: price.price,
      taxInclusive: true,
      availability: { status: 'low', onlyLeft: 4 },
    });
  });

  it('asks the price and the stock only after the Offer and the seller pass', async () => {
    const { facts, calls } = build({ eligible: false });

    const out = await facts.evaluate(context, [ref]);

    expect(out.get(key)).toMatchObject({ state: 'unavailable', reason: 'seller-not-eligible' });
    expect(calls).toEqual(['catalog', 'sellers']);
  });

  it.each([
    ['an unknown Offer', { offer: null }],
    ['a deleted Offer', { offer: { ...published, status: 'deleted' as const, sellUnits: [] } }],
    ['an unlisted Offer', { offer: { ...published, listed: false } }],
    ['a draft Offer', { offer: { ...published, status: 'draft' as const } }],
    [
      'a proposed sell unit',
      { offer: { ...published, sellUnits: [{ variantId: VARIANT, state: 'proposed' as const }] } },
    ],
    [
      'another variant',
      {
        offer: {
          ...published,
          sellUnits: [{ variantId: id<'Variant'>(9), state: 'published' as const }],
        },
      },
    ],
  ])('refuses %s as offer-unavailable', async (_name, over) => {
    expect(await verdict(over)).toMatchObject({
      state: 'unavailable',
      reason: 'offer-unavailable',
    });
  });

  it('refuses a sell unit with no price, and one that is out of stock', async () => {
    expect(await verdict({ price: null })).toMatchObject({
      state: 'unavailable',
      reason: 'no-valid-price',
    });
    expect(await verdict({ stock: null })).toMatchObject({
      state: 'unavailable',
      reason: 'out-of-stock',
    });
    expect(await verdict({ stock: { sellable: 0, status: 'out', onlyLeft: null } })).toMatchObject({
      state: 'unavailable',
      reason: 'out-of-stock',
    });
  });

  it.each([
    ['catalog fails', { catalog: 'fail' as const }],
    ['sellers fails', { eligible: 'fail' as const }],
    ['sellers throws', { eligible: 'throw' as const }],
    ['pricing fails', { price: 'fail' as const }],
    ['inventory fails', { stock: 'fail' as const }],
  ])('fails closed when %s', async (_name, over) => {
    expect(await verdict(over)).toMatchObject({ state: 'check-unavailable' });
  });

  it('answers nothing for no sell units and asks nobody', async () => {
    const { facts, calls } = build();

    expect((await facts.evaluate(context, [])).size).toBe(0);
    expect(calls).toEqual([]);
  });
});
