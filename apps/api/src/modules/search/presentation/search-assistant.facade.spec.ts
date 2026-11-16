import { money, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { ProductDetail } from '../application/use-cases/view-product-detail.use-case';
import { SearchAssistantFacadeImplementation } from './search-assistant.facade';

// Cards read the price of pricing and the store name through the product page read (B1).

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0x51);
const OTHER_SELLER = id<'Seller'>(0x52);
const PRODUCT = id<'Product'>(0xe1);
const OFFER = id<'Offer'>(0xf1);
const OTHER_OFFER = id<'Offer'>(0xf2);
const AUD = (cents: bigint) => money(cents, 'AUD');

const unit = (variant: number, cents: bigint) => ({
  variantId: id<'Variant'>(variant),
  label: null,
  price: AUD(cents),
  taxInclusive: true,
  special: null,
  stock: { status: 'in-stock' as const, onlyLeft: null },
});

const page = (): ProductDetail =>
  ({
    productId: PRODUCT,
    name: 'Ghee',
    shortDescription: 'Clarified butter',
    description: 'Made from butter',
    categoryIds: [],
    brand: { slug: 'golden', name: 'Golden' },
    specifications: [
      {
        groupCode: 'g',
        specifications: [
          { code: 'w', name: 'Weight', value: { kind: 'measure', value: '500', unitLabel: 'g' } },
          { code: 'v', name: 'Vegan', value: { kind: 'boolean', value: false } },
        ],
      },
    ],
    images: [],
    variantImages: [],
    offers: [
      {
        offerId: OFFER,
        sellerId: SELLER,
        seller: { storeName: 'Fresh Farm' },
        units: [unit(1, 1500n), unit(2, 1250n)],
        badges: [
          {
            typeCode: 'halal',
            typeName: 'Halal',
            basis: 'SELLER',
            sellerClaim: true,
            issuerName: null,
            validUntilLocalDate: null,
            verifiedWithIssuer: false,
          },
        ],
      },
      {
        offerId: OTHER_OFFER,
        sellerId: OTHER_SELLER,
        seller: { storeName: null },
        units: [unit(3, 1800n)],
        badges: [],
      },
    ],
  }) as unknown as ProductDetail;

describe('SearchAssistantFacadeImplementation', () => {
  const context: CallContext = testCallContext(testMarketContext('AU', 'default'), 'anonymous');
  const item = (offerId: Id<'Offer'>, sellerId: Id<'Seller'>) => ({
    offerId,
    productId: PRODUCT,
    sellerId,
    name: 'Ghee',
    shortText: null,
    categoryIds: [],
    primaryImage: null,
  });
  let detailAnswer: unknown;
  let detailCalls: number;
  let storeAnswer: unknown;
  const make = () =>
    new SearchAssistantFacadeImplementation(
      {
        execute: () =>
          Promise.resolve({
            ok: true,
            value: { items: [item(OFFER, SELLER), item(OTHER_OFFER, OTHER_SELLER)] },
          }),
      } as never,
      {
        execute: () => Promise.resolve({ ok: true, value: { items: [item(OFFER, SELLER)] } }),
      } as never,
      {
        execute: () =>
          Promise.resolve({
            ok: true,
            value: {
              items: [
                {
                  ...item(OFFER, SELLER),
                  price: AUD(990n),
                  regularPrice: AUD(1250n),
                  taxInclusive: true,
                },
              ],
            },
          }),
      } as never,
      {
        execute: () => {
          detailCalls += 1;
          return Promise.resolve(detailAnswer);
        },
      } as never,
      { execute: () => Promise.resolve(storeAnswer) } as never,
    );

  beforeEach(() => {
    detailAnswer = { ok: true, value: page() };
    detailCalls = 0;
    storeAnswer = {
      ok: true,
      value: { items: [{ slug: 'fresh-farm', name: 'Fresh Farm', productCount: 7 }] },
    };
  });

  it('gives every result its lowest price (a "from" price when units differ) and store name', async () => {
    const found = await make().searchProducts(context, {
      text: 'ghee',
      categoryId: null,
      limit: 6,
    });
    expect(found).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          offerId: OFFER,
          sellerName: 'Fresh Farm',
          price: AUD(1250n),
          regularPrice: null,
          taxInclusive: true,
          priceFrom: true,
        }),
        expect.objectContaining({
          offerId: OTHER_OFFER,
          sellerName: null,
          price: AUD(1800n),
          priceFrom: false,
        }),
      ],
    });
    // One product page read per distinct product, not per result.
    expect(detailCalls).toBe(1);
  });

  it('leaves the price and store name empty when the page read fails: never a guess', async () => {
    detailAnswer = { ok: false, error: { code: 'search.unavailable' } };
    const found = await make().bestsellers(context, { categoryId: null, limit: 6 });
    expect(found).toEqual({
      ok: true,
      value: [expect.objectContaining({ price: null, taxInclusive: null, sellerName: null })],
    });
  });

  it('keeps the special price of the shelf and adds only the store name', async () => {
    const found = await make().specials(context, { categoryId: null, limit: 6 });
    expect(found).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          price: AUD(990n),
          regularPrice: AUD(1250n),
          sellerName: 'Fresh Farm',
        }),
      ],
    });
  });

  it('answers a product page for the assistant: cheapest Offer first, no stock, text values', async () => {
    const found = await make().productDetail(context, PRODUCT);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.attributes).toEqual([
      { name: 'Weight', value: '500 g' },
      { name: 'Vegan', value: 'no' },
    ]);
    expect(found.value.brandName).toBe('Golden');
    expect(found.value.offers[0]).toEqual({
      offerId: OFFER,
      sellerId: SELLER,
      sellerName: 'Fresh Farm',
      price: AUD(1250n),
      taxInclusive: true,
      priceFrom: true,
      badges: [{ typeCode: 'halal', typeName: 'Halal', sellerClaim: true }],
    });
    expect(Object.keys(found.value.offers[0])).not.toContain('stock');
  });

  it('maps a missing product to not-found and any other refusal to unavailable', async () => {
    detailAnswer = { ok: false, error: { code: 'search.product-not-found' } };
    expect(await make().productDetail(context, PRODUCT)).toEqual({
      ok: false,
      error: { code: 'not-found' },
    });
    detailAnswer = { ok: false, error: { code: 'search.unavailable' } };
    expect(await make().productDetail(context, PRODUCT)).toEqual({
      ok: false,
      error: { code: 'search.unavailable' },
    });
  });

  it('counts a store from the store query by its address, or null', async () => {
    const facade = make();
    expect(
      await facade.storeProductCount(context, { slug: 'fresh-farm', name: 'Fresh Farm' }),
    ).toBe(7);
    expect(
      await facade.storeProductCount(context, { slug: 'other', name: 'Fresh Farm' }),
    ).toBeNull();
    storeAnswer = { ok: false, error: { code: 'search.unavailable' } };
    expect(
      await facade.storeProductCount(context, { slug: 'fresh-farm', name: 'Fresh Farm' }),
    ).toBeNull();
    expect(await facade.storeProductCount(context, { slug: 'fresh-farm', name: 'x' })).toBeNull();
  });
});
