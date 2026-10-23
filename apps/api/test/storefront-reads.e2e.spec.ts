import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import request from 'supertest';
import { CategoryTreeQuery } from '../src/modules/catalog/application/use-cases/category-tree.use-case';
import { ListBestsellers } from '../src/modules/search/application/use-cases/list-bestsellers.use-case';
import { ViewProductDetail } from '../src/modules/search/application/use-cases/view-product-detail.use-case';
import { ListSpecials } from '../src/modules/search/application/use-cases/list-specials.use-case';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The storefront read routes over HTTP (storefront reads package): GET /catalog/categories,
// GET /search/bestsellers, GET /search/specials and GET /search/product-detail/:productId with the real guards, rate limiter and
// controllers; the use cases are stubs. This proves anonymous access (no session, no CSRF), the
// request Market, the strict query string, the answer shapes (Money as a string amount and its
// currency), `no-store` and the status of each refusal.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CATEGORY = id<'Category'>(0xca);
const IMAGE = {
  imageId: id<'ProductImage'>(0x701),
  width: 1600,
  height: 1200,
  alt: 'Halal sausages',
};
const ITEM = {
  offerId: id<'Offer'>(1),
  productId: id<'Product'>(2),
  sellerId: id<'Seller'>(3),
  name: 'Halal sausages',
  shortText: null,
  categoryIds: [CATEGORY],
  primaryImage: IMAGE,
};
const ENDS = '2026-10-20T00:00:00Z';
const PRODUCT = ITEM.productId;

type Call = { route: string; actor: string; market: string; input: unknown };

describe.each(TEST_MARKETS)('storefront reads over HTTP in market %s', (code) => {
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  let app: NestExpressApplication;
  let calls: Call[];
  const next: Record<string, unknown> = {};
  const get = (path: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(path)
      .set({ 'x-market-id': code, ...headers });
  const stub = (route: string) => ({
    execute: (
      context: { actor: { kind: string }; market: { marketId: string } },
      input: unknown,
    ) => {
      calls.push({ route, actor: context.actor.kind, market: context.market.marketId, input });
      return Promise.resolve(next[route]);
    },
  });

  beforeEach(async () => {
    calls = [];
    next.tree = ok({
      locale: 'en-AU',
      categories: [
        { id: CATEGORY, parentId: null, slug: 'meat', name: 'Meat', depth: 0, position: 0 },
      ],
    });
    next.bestsellers = ok({ items: [ITEM] });
    next.specials = ok({
      items: [
        {
          ...ITEM,
          variantId: id<'Variant'>(4),
          price: { amount: 800n, currency },
          regularPrice: { amount: 1000n, currency },
          taxInclusive: true,
          specialEndsAt: Temporal.Instant.from(ENDS),
        },
      ],
    });
    next.detail = ok({
      productId: PRODUCT,
      name: 'Halal sausages',
      shortDescription: null,
      description: 'Beef',
      categoryIds: [CATEGORY],
      images: [IMAGE, { ...IMAGE, imageId: id<'ProductImage'>(0x702), width: 800, height: 800 }],
      offers: [
        {
          offerId: ITEM.offerId,
          sellerId: ITEM.sellerId,
          seller: { storeName: 'Butcher', minimumOrder: { amount: 2500n, currency } },
          units: [
            {
              variantId: id<'Variant'>(4),
              label: '500 g',
              price: { amount: 800n, currency },
              taxInclusive: true,
              special: { endsAt: Temporal.Instant.from(ENDS) },
              stock: { status: 'low', onlyLeft: 2 },
            },
          ],
        },
      ],
    });
    ({ app } = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(CategoryTreeQuery)
          .useValue(stub('tree'))
          .overrideProvider(ListBestsellers)
          .useValue(stub('bestsellers'))
          .overrideProvider(ListSpecials)
          .useValue(stub('specials'))
          .overrideProvider(ViewProductDetail)
          .useValue(stub('detail')),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('answers the category tree to a visitor with no session, not cacheable', async () => {
    const response = await get('/catalog/categories', {
      cookie: `__Host-session-customer-${code}=whatever`,
    });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toEqual({
      locale: 'en-AU',
      categories: [
        { id: CATEGORY, parentId: null, slug: 'meat', name: 'Meat', depth: 0, position: 0 },
      ],
    });
    expect(calls).toEqual([{ route: 'tree', actor: 'anonymous', market: code, input: {} }]);
  });

  it('answers the best sellers with the strict query string', async () => {
    const response = await get(`/search/bestsellers?category=${CATEGORY}&limit=6`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ items: [ITEM] });
    expect(calls).toEqual([
      {
        route: 'bestsellers',
        actor: 'anonymous',
        market: code,
        input: { category: CATEGORY, limit: 6 },
      },
    ]);
  });

  it('answers the specials with Money as a string amount and the Market currency', async () => {
    const response = await get('/search/specials');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      items: [
        {
          ...ITEM,
          variantId: id<'Variant'>(4),
          price: { amount: '800', currency },
          regularPrice: { amount: '1000', currency },
          taxInclusive: true,
          specialEndsAt: ENDS,
        },
      ],
    });
    expect(calls[0]).toMatchObject({ route: 'specials', actor: 'anonymous', input: {} });
  });

  it('answers the product page with Money as a string amount, not cacheable', async () => {
    const response = await get(`/search/product-detail/${PRODUCT}`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toEqual({
      productId: PRODUCT,
      name: 'Halal sausages',
      shortDescription: null,
      description: 'Beef',
      categoryIds: [CATEGORY],
      images: [IMAGE, { ...IMAGE, imageId: id<'ProductImage'>(0x702), width: 800, height: 800 }],
      offers: [
        {
          offerId: ITEM.offerId,
          sellerId: ITEM.sellerId,
          seller: { storeName: 'Butcher', minimumOrder: { amount: '2500', currency } },
          units: [
            {
              variantId: id<'Variant'>(4),
              label: '500 g',
              price: { amount: '800', currency },
              taxInclusive: true,
              special: { endsAt: ENDS },
              stock: { status: 'low', onlyLeft: 2 },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain('sellable');
    expect(JSON.stringify(response.body)).not.toMatch(/objectKey|object_key|sha256|uploader|http/);
    expect(calls).toEqual([
      { route: 'detail', actor: 'anonymous', market: code, input: { productId: PRODUCT } },
    ]);
  });

  it('refuses a market-less request before any use case', async () => {
    const responses = await Promise.all(
      [
        '/catalog/categories',
        '/search/bestsellers',
        '/search/specials',
        `/search/product-detail/${PRODUCT}`,
      ].map((path) => request(app.getHttpServer()).get(path)),
    );

    for (const response of responses) expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ['/catalog/categories?depth=2', 'depth'],
    ['/search/bestsellers?sort=price', 'sort'],
    ['/search/bestsellers?limit=six', 'limit'],
    ['/search/bestsellers?limit=-1', 'limit'],
    ['/search/specials?category=a&category=b', 'category'],
    ['/search/specials?limit[a]=1', 'limit[a]'],
    [`/search/product-detail/${PRODUCT}?locale=fr`, 'locale'],
    [`/search/product-detail/${PRODUCT}?a=1&b=2`, 'a'],
  ])('answers 400 for %s without calling the use case', async (path, field) => {
    const response = await get(path);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'validation.failed',
      details: {
        fields: expect.arrayContaining([expect.objectContaining({ path: field })]) as unknown,
      },
    });
    expect(calls).toEqual([]);
  });

  it('maps the product page refusals: bad id 400, not found 404, unavailable 503', async () => {
    next.detail = err({
      code: 'validation.failed',
      fields: [{ path: 'productId', code: 'format' }],
    });
    const invalid = await get('/search/product-detail/not-a-uuid');
    next.detail = err({ code: 'search.product-not-found' });
    const missing = await get(`/search/product-detail/${PRODUCT}`);
    next.detail = err({ code: 'search.unavailable' });
    const unavailable = await get(`/search/product-detail/${PRODUCT}`);

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'productId', code: 'format' }] },
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ statusCode: 404, code: 'search.product-not-found' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ statusCode: 503, code: 'search.unavailable' });
  });

  it('maps the refusals: validation 400, unavailable 503', async () => {
    next.bestsellers = err({
      code: 'validation.failed',
      fields: [{ path: 'limit', code: 'range' }],
    });
    next.specials = err({ code: 'search.unavailable' });
    next.tree = err({ code: 'catalog.categories-unavailable' });

    const invalid = await get('/search/bestsellers?limit=99');
    const unavailable = await get('/search/specials');
    const tree = await get('/catalog/categories');

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'limit', code: 'range' }] },
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ statusCode: 503, code: 'search.unavailable' });
    expect(tree.status).toBe(503);
    expect(tree.body).toEqual({ statusCode: 503, code: 'catalog.categories-unavailable' });
  });
});
