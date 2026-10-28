import { describe, expect, it } from 'vitest';
import { liveCartOf, liveSavedOf, unitKey, unitOf } from '../src/cart/live-cart.ts';
import { photoUrlBuilder } from '../src/storefront/photos.ts';

// The real cart's bodies (`GET /cart`, `GET /cart/saved`) as the cart screens show them, in two
// Markets: what is shown, what is set aside as not available, and what is dropped.

const OFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VARIANT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OFFER_B = '16fd2706-8baf-433b-82eb-8c7fada847da';
const SELLER = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
const PRODUCT = '9b2d3a0e-3c1f-4a55-8f3e-2c1d0e9f8a7b';
const IMAGE = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const LINE = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const LINE_B = 'a8098c1a-f86e-41a6-8c4b-2c4b3d5e6f70';
const SAVED = 'e02fd0e4-00fd-490a-9a3c-3f3d6c1b2a10';

describe.each([
  ['AU', 'AUD'],
  ['NZ', 'NZD'],
] as const)('the real cart in market %s', (market, currency) => {
  const photo = photoUrlBuilder('https://img.example.com', market);
  const money = (amount: string) => ({ amount, currency });
  const line = (extra: object = {}) => ({
    lineId: LINE,
    offerId: OFFER,
    variantId: VARIANT,
    quantity: 2,
    state: 'buyable',
    reason: null,
    unitPrice: money('1250'),
    previousPrice: null,
    availability: { status: 'in-stock', onlyLeft: null },
    display: {
      productId: PRODUCT,
      productName: 'Lamb mince',
      variantLabel: '500 g',
      imageId: IMAGE,
    },
    ...extra,
  });
  const group = (lines: object[], extra: object = {}) => ({
    sellerId: SELLER,
    sellerName: 'Halal Corner',
    subtotal: money('2500'),
    minimumOrder: { state: 'none', minimum: null },
    deliveryFee: money('750'),
    lines,
    ...extra,
  });
  const key = unitKey({ offerId: OFFER, variantId: VARIANT });

  it('shows a buyable line with its name, label, photo, price and seller terms', () => {
    const cart = liveCartOf({ groups: [group([line()])], lineCount: 1 }, photo);

    expect(cart?.cart).toEqual({
      [key]: { quantity: 2, unitPrice: { amount: 1250, currency }, limit: 12 },
    });
    expect(cart?.source.items[key]).toEqual({
      name: 'Lamb mince, 500 g',
      sellerId: SELLER,
      sellerName: 'Halal Corner',
      category: '',
      price: { amount: 1250, currency },
      imageUrl: `https://img.example.com/catalog/public-images/${market}/${PRODUCT}/${IMAGE}/thumb`,
    });
    expect(cart?.source.sellers[SELLER]).toEqual({
      id: SELLER,
      name: 'Halal Corner',
      deliveryWindow: '',
      deliveryFee: { amount: 750, currency },
    });
    expect(cart?.lineIds).toEqual({ [key]: LINE });
    expect(cart?.unavailable).toEqual([]);
    expect(cart?.source.sampleDiscounts).toEqual({});
  });

  it('carries low stock, a changed price and the minimum the API says applies', () => {
    const cart = liveCartOf(
      {
        groups: [
          group(
            [
              line({
                availability: { status: 'low', onlyLeft: 3 },
                previousPrice: money('1100'),
              }),
            ],
            { minimumOrder: { state: 'below-minimum', minimum: money('4000') } },
          ),
        ],
      },
      null,
    );

    expect(cart?.source.items[key]).toMatchObject({
      lowStock: 3,
      addedAt: { amount: 1100, currency },
    });
    expect(cart?.source.items[key]?.imageUrl).toBeUndefined();
    expect(cart?.cart[key]?.limit).toBe(3);
    expect(cart?.source.sellers[SELLER]?.minimumOrder).toEqual({ amount: 4000, currency });
  });

  it('sets aside lines that cannot be bought, and a seller without a delivery fee', () => {
    const cart = liveCartOf(
      {
        groups: [
          group([
            line(),
            line({
              lineId: LINE_B,
              offerId: OFFER_B,
              state: 'unavailable',
              reason: 'out-of-stock',
              display: null,
            }),
          ]),
          group([line({ offerId: OFFER_B, variantId: OFFER, lineId: OFFER })], {
            sellerId: PRODUCT,
            deliveryFee: null,
          }),
        ],
      },
      photo,
    );

    expect(Object.keys(cart?.cart ?? {})).toEqual([key]);
    expect(cart?.unavailable).toEqual([
      { key: unitKey({ offerId: OFFER_B, variantId: VARIANT }), lineId: LINE_B, name: null },
      {
        key: unitKey({ offerId: OFFER_B, variantId: OFFER }),
        lineId: OFFER,
        name: 'Lamb mince, 500 g',
      },
    ]);
    expect(Object.keys(cart?.source.sellers ?? {})).toEqual([SELLER]);
  });

  it('drops a line with a bad id or quantity, and answers null for a body that is not a cart', () => {
    const cart = liveCartOf(
      {
        groups: [
          group([line({ lineId: 'x' }), line({ quantity: 0 }), line({ unitPrice: money('1.5') })]),
        ],
      },
      photo,
    );
    expect(cart?.cart).toEqual({});
    expect(cart?.unavailable).toHaveLength(1);
    expect(liveCartOf({ lines: [] }, photo)).toBeNull();
    expect(liveCartOf(null, photo)).toBeNull();
  });

  it("reads the account's saved list, an unbuyable item without an item", () => {
    const saved = liveSavedOf(
      {
        items: [
          { ...line(), savedId: SAVED, sellerId: SELLER, sellerName: 'Halal Corner' },
          {
            ...line({ offerId: OFFER_B, state: 'unavailable', unitPrice: null }),
            savedId: LINE_B,
            sellerId: null,
            sellerName: null,
          },
          { savedId: 'bad' },
        ],
      },
      photo,
    );

    expect(saved?.map((s) => [s.key, s.savedId, s.item?.name ?? null])).toEqual([
      [key, SAVED, 'Lamb mince, 500 g'],
      [unitKey({ offerId: OFFER_B, variantId: VARIANT }), LINE_B, null],
    ]);
    expect(saved?.[0]?.item?.sellerName).toBe('Halal Corner');
    expect(liveSavedOf({}, photo)).toBeNull();
  });
});

describe('cart keys', () => {
  it('round-trips a sell unit and refuses anything else', () => {
    expect(unitOf(unitKey({ offerId: OFFER, variantId: VARIANT }))).toEqual({
      offerId: OFFER,
      variantId: VARIANT,
    });
    expect(unitOf('brisket')).toBeNull();
    expect(unitOf(`${OFFER}:${VARIANT}:x`)).toBeNull();
    expect(unitOf(`${OFFER}:not-a-uuid`)).toBeNull();
  });
});
