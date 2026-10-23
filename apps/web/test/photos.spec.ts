import { describe, expect, it } from 'vitest';
import { cardOf, cardsOf, homeFrom } from '../src/storefront/home-source.ts';
import {
  imageIdOf,
  imageIdsOf,
  parseImageOrigin,
  photoUrlBuilder,
} from '../src/storefront/photos.ts';
import { parseStorefrontApiConfig } from '../src/storefront/config.ts';
import { productDetailOf, type ProductDetailBody } from '../src/storefront/product-detail.ts';

// Photo references from the API become browser URLs here, by code, from validated ids only.

const PRODUCT = '01990000-0000-7000-8000-000000000900';
const P1 = '01990000-0000-7000-8000-0000000000a1';
const P2 = '01990000-0000-7000-8000-0000000000a2';
const ref = (imageId: string, extra: Record<string, unknown> = {}) => ({
  imageId,
  width: 1200,
  height: 900,
  alt: 'Lamb shoulder',
  ...extra,
});
const photo = photoUrlBuilder('https://img.example.com', 'AU')!;

describe('the photo origin', () => {
  it('is off when empty or absent, so no photo is shown', () => {
    expect(parseImageOrigin(undefined)).toBeNull();
    expect(parseImageOrigin('  ')).toBeNull();
    expect(photoUrlBuilder(null, 'AU')).toBeNull();
    expect(photoUrlBuilder('https://img.example.com', null)).toBeNull();
    expect(photoUrlBuilder('https://img.example.com', 'au')).toBeNull();
  });

  it('is a bare origin: https, or http on localhost only', () => {
    expect(parseImageOrigin('https://img.example.com')).toBe('https://img.example.com');
    expect(parseImageOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(parseImageOrigin('http://img.localhost:3000')).toBe('http://img.localhost:3000');
  });

  it.each([
    'img.example.com',
    'https://img.example.com/media',
    'https://img.example.com/',
    'http://img.example.com',
    'ftp://img.example.com',
    'https://user:pw@img.example.com',
    'javascript:alert(1)',
  ])('refuses %s at start-up', (raw) => {
    expect(() => parseImageOrigin(raw)).toThrow(/STOREFRONT_IMAGE_ORIGIN/);
  });

  it('is read with the rest of the API configuration', () => {
    const env = {
      API_BASE_URL: 'http://localhost:3000',
      STOREFRONT_HOSTS: 'http://storefront.localhost:3003=AU',
    };
    expect(parseStorefrontApiConfig(env)?.imageOrigin).toBeNull();
    expect(
      parseStorefrontApiConfig({ ...env, STOREFRONT_IMAGE_ORIGIN: 'http://localhost:3000' })
        ?.imageOrigin,
    ).toBe('http://localhost:3000');
    expect(() =>
      parseStorefrontApiConfig({ ...env, STOREFRONT_IMAGE_ORIGIN: 'https://x.test/a' }),
    ).toThrow(/STOREFRONT_IMAGE_ORIGIN/);
  });
});

describe('the photo URL', () => {
  it('names the Market, product, photo and size', () => {
    expect(photo(PRODUCT, P1, 'medium')).toBe(
      `https://img.example.com/catalog/public-images/AU/${PRODUCT}/${P1}/medium`,
    );
  });

  it('is built only from UUIDs, so nothing else reaches the path', () => {
    expect(photo(PRODUCT, '../../x', 'large')).toBeUndefined();
    expect(photo('not-a-uuid', P1, 'large')).toBeUndefined();
    expect(photo(PRODUCT, `${P1}/../..`, 'thumb')).toBeUndefined();
  });
});

describe('reading photo references', () => {
  it('takes the id of a well-formed reference', () => {
    expect(imageIdOf(ref(P1))).toBe(P1);
    expect(imageIdOf(ref(P1.toUpperCase()))).toBe(P1);
  });

  it.each([
    ['not an object', 'x'],
    ['an array', [ref(P1)]],
    ['null', null],
    ['no id', { ...ref(P1), imageId: undefined }],
    ['a path as id', ref('../../etc/passwd')],
    ['a URL as id', ref('https://evil.example/x.jpg')],
    ['a string width', ref(P1, { width: '1200' })],
    ['a zero height', ref(P1, { height: 0 })],
    ['a huge width', ref(P1, { width: 1_000_000 })],
    ['a fractional height', ref(P1, { height: 1.5 })],
    ['a missing alt', ref(P1, { alt: undefined })],
  ])('drops a reference that is %s', (_name, value) => {
    expect(imageIdOf(value)).toBeUndefined();
  });

  it('keeps valid references only, in order, without repeats, at most eight', () => {
    expect(imageIdsOf([ref(P1), 'junk', ref('bad'), ref(P2), ref(P1)])).toEqual([P1, P2]);
    const many = Array.from({ length: 12 }, (_, i) =>
      ref(`01990000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`),
    );
    expect(imageIdsOf(many)).toHaveLength(8);
    expect(imageIdsOf(undefined)).toEqual([]);
    expect(imageIdsOf({ 0: ref(P1) })).toEqual([]);
  });
});

describe('cards with photos', () => {
  const item = (primaryImage: unknown) => ({
    productId: PRODUCT,
    name: 'Lamb shoulder',
    categoryIds: [],
    primaryImage,
  });

  it('gets the medium photo from primaryImage', () => {
    expect(cardOf(item(ref(P1)), new Map(), photo)?.imageUrl).toBe(
      `https://img.example.com/catalog/public-images/AU/${PRODUCT}/${P1}/medium`,
    );
  });

  it('keeps the illustration without a photo, with photos off or with a bad reference', () => {
    expect(cardOf(item(null), new Map(), photo)?.imageUrl).toBeUndefined();
    expect(cardOf(item(ref(P1)), new Map(), null)?.imageUrl).toBeUndefined();
    expect(cardOf(item(ref('../x')), new Map(), photo)?.imageUrl).toBeUndefined();
    expect(cardOf(item(undefined), new Map())?.imageUrl).toBeUndefined();
  });

  it('never lets a bad reference remove the card', () => {
    const cards = cardsOf({ items: [item({ imageId: 7 })] }, new Map(), photo);
    expect(cards.map((c) => c.name)).toEqual(['Lamb shoulder']);
  });

  it('carries the photo to a home shelf', () => {
    const home = homeFrom(
      {
        page: {
          kind: 'ok',
          body: {
            kind: 'page',
            page: {
              slots: [
                {
                  modules: [
                    {
                      id: 'm',
                      module: 'product-shelf',
                      config: { source: { kind: 'bestsellers' }, limit: 12 },
                    },
                  ],
                },
              ],
            },
          },
        },
        tree: { kind: 'ok', body: { categories: [] } },
        shelves: new Map([
          ['search/bestsellers?limit=12', { kind: 'ok', body: { items: [item(ref(P1))] } }],
        ]),
      },
      false,
      photo,
    );
    const section = home.sections.find((s) => s.kind === 'products');
    expect(section?.kind === 'products' && section.products[0]?.imageUrl).toContain(
      `/${P1}/medium`,
    );
  });
});

describe('the product page photos', () => {
  const body = (images: unknown): ProductDetailBody => ({
    productId: PRODUCT,
    name: 'Lamb shoulder',
    shortDescription: null,
    description: null,
    categoryIds: [],
    images,
    offers: [
      {
        offerId: '01990000-0000-7000-8000-000000001001',
        sellerId: '01990000-0000-7000-8000-000000005001',
        seller: { storeName: 'Kedron Butchers' },
        units: [
          {
            variantId: '01990000-0000-7000-8000-000000002001',
            label: null,
            price: { amount: '1890', currency: 'AUD' },
            taxInclusive: true,
            special: null,
            stock: { status: 'in-stock', onlyLeft: null },
          },
        ],
      },
    ],
  });
  const labels = { minimum: (a: string) => a, noMinimum: 'none' };

  it('shows the large photos in order, with small ones for the strip', () => {
    const detail = productDetailOf(body([ref(P1), ref(P2)]), 'en', labels, photo)!;
    expect(detail.photos).toEqual([
      `https://img.example.com/catalog/public-images/AU/${PRODUCT}/${P1}/large`,
      `https://img.example.com/catalog/public-images/AU/${PRODUCT}/${P2}/large`,
    ]);
    expect(detail.photoThumbs?.map((u) => u.split('/').at(-1))).toEqual(['thumb', 'thumb']);
  });

  it('has no strip for one photo and no photos when off, absent or malformed', () => {
    expect(productDetailOf(body([ref(P1)]), 'en', labels, photo)?.photoThumbs).toBeUndefined();
    expect(productDetailOf(body([ref(P1)]), 'en', labels, null)?.photos).toEqual([]);
    expect(productDetailOf(body([]), 'en', labels, photo)?.photos).toEqual([]);
    expect(productDetailOf(body(undefined), 'en', labels, photo)?.photos).toEqual([]);
    expect(productDetailOf(body('x'), 'en', labels, photo)?.photos).toEqual([]);
    expect(productDetailOf(body([{ imageId: P1 }]), 'en', labels, photo)?.photos).toEqual([]);
  });
});
