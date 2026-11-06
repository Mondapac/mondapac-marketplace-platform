import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import type { ProductDetail, UnavailableProduct } from '../src/storefront/types.ts';

// SEO package 5: the product route's redirects and 404s, and the address it gives the page.
// `next/navigation` is replaced by throwers that name what the route asked for, as Next does.

const ID = '3f2b8c1e-9a4d-4e6b-8f10-2d7c5a9b0e11';
const REMOVED_ID = '9b1d6c2a-0e5f-4a3b-9c7d-8e2f1a4b6c50';
const NAME = 'Halal Lamb Shoulder, 1 kg';
const CURRENT = `halal-lamb-shoulder-1-kg-${ID}`;

const world = vi.hoisted(() => ({ host: 'shop.example' }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(world.host === null ? {} : { host: world.host })),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(createTranslator({ locale: 'en', messages, namespace: namespace as 'store' })),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
  permanentRedirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;308;${url}`);
  },
}));
vi.mock('../src/storefront/config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  storefrontApiConfig: () => ({
    apiBaseUrl: 'https://api.shop.example',
    hosts: [{ origin: 'https://shop.example', host: 'shop.example', marketId: 'AU' }],
    clientAddressKey: null,
  }),
}));
vi.mock('../src/storefront/source.ts', async (importOriginal) => {
  const actual = await importOriginal<object>();
  const { sampleProduct } = await import('../src/storefront/sample-product.ts');
  const { sampleUnavailableProduct } = await import('../src/storefront/sample-unavailable.ts');
  const catalog = {
    [ID]: { ...sampleProduct('lamb-shoulder')!, id: ID, name: NAME } satisfies ProductDetail,
  } as Record<string, ProductDetail>;
  const removed = {
    [REMOVED_ID]: { ...sampleUnavailableProduct('lamb-leg-roast')!, id: REMOVED_ID },
  } as Record<string, UnavailableProduct>;
  return {
    ...actual,
    // With the API on, only a catalog id (a UUID) is a product: the lookup is by that id.
    loadProduct: (id: string) => Promise.resolve(catalog[id]),
    loadUnavailableProduct: (id: string) => Promise.resolve(removed[id]),
    loadStorefrontContent: () =>
      (actual as { loadStorefrontContent: () => unknown }).loadStorefrontContent(),
  };
});
vi.mock('../src/reviews/reviews-source.ts', () => ({
  loadProductReviews: () => Promise.resolve(null),
}));

const { removedProductOfPath, resolveProduct } = await import('../src/storefront/product-route.ts');
const page = await import('../app/p/[id]/page.tsx');

const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as Error).message;
  }
};
const go = (segment: string, query: Record<string, string | string[] | undefined> = {}) =>
  outcome(resolveProduct(segment, query));

afterEach(() => {
  vi.unstubAllEnvs();
  world.host = 'shop.example';
});

describe('/p/<name>-<id>', () => {
  it('answers 200 for the current path', async () => {
    expect(await go(CURRENT)).toBe('ok');
    expect(await resolveProduct(CURRENT, {})).toMatchObject({ path: `/p/${CURRENT}` });
  });

  it('redirects a path with no name, an old name or a wrong one to the current path (308)', async () => {
    const to = `NEXT_REDIRECT;308;/p/${CURRENT}`;
    expect(await go(ID)).toBe(to);
    expect(await go(`lamb-${ID}`)).toBe(to);
    expect(await go(`old-name-${ID}`)).toBe(to);
    expect(await go(ID.toUpperCase())).toBe(to);
    expect(await go(`HALAL-LAMB-SHOULDER-1-KG-${ID}`)).toBe(to);
  });

  it('keeps the query string on a redirect', async () => {
    expect(await go(ID, { v: 'abc' })).toBe(`NEXT_REDIRECT;308;/p/${CURRENT}?v=abc`);
    expect(await go(ID, { v: 'a b', utm: ['1', '2'], none: undefined })).toBe(
      `NEXT_REDIRECT;308;/p/${CURRENT}?v=a+b&utm=1&utm=2`,
    );
  });

  it('builds the target from the id and the name, never from the requested slug text', async () => {
    for (const segment of [
      `%2F%2Fevil.example%2Fx-${ID}`,
      `..%2F..%2Fevil-${ID}`,
      `https%3A%2F%2Fevil.example-${ID}`,
      `%0d%0aLocation%3A%20x-${ID}`,
    ]) {
      const target = (await go(segment)).replace('NEXT_REDIRECT;308;', '');
      expect(target).toBe(`/p/${CURRENT}`);
    }
    // A query is only ever appended after `?`, so it cannot change the origin or path.
    expect(await go(ID, { next: '//evil.example' })).toBe(
      `NEXT_REDIRECT;308;/p/${CURRENT}?next=%2F%2Fevil.example`,
    );
  });

  it('answers 404 for an unknown product, a removed product and a path with no id', async () => {
    const unknown = 'NEXT_HTTP_ERROR_FALLBACK;404';
    expect(await go('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a')).toBe(unknown);
    expect(await go(`halal-lamb-${'0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'}`)).toBe(unknown);
    expect(await go(`lamb-${REMOVED_ID}`)).toBe(unknown);
    expect(await go('lamb-shoulder')).toBe(unknown);
    expect(await go(`${ID}-lamb`)).toBe(unknown);
    expect(await go('')).toBe(unknown);
  });

  it('keeps the removed product for the 404 page body, found by the path', async () => {
    const removed = await removedProductOfPath(`/p/old-name-${REMOVED_ID}`);
    expect(removed).toMatchObject({ id: REMOVED_ID, name: 'Lamb leg roast, 2 kg' });
    expect(await removedProductOfPath(`/p/${ID}`)).toBeUndefined();
    expect(await removedProductOfPath('/s/x')).toBeUndefined();
    expect(await removedProductOfPath(null)).toBeUndefined();
    expect(await removedProductOfPath('/p/%E0%A4%A')).toBeUndefined();
  });
});

describe('the page route', () => {
  const props = (id: string, query: Record<string, string> = {}) => ({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(query),
  });

  it('answers a redirect or a 404 from the page itself, before any markup', async () => {
    expect(await outcome(page.default(props(ID)))).toBe(`NEXT_REDIRECT;308;/p/${CURRENT}`);
    expect(await outcome(page.default(props(ID, { v: 'x' })))).toBe(
      `NEXT_REDIRECT;308;/p/${CURRENT}?v=x`,
    );
    expect(await outcome(page.default(props('nope')))).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await outcome(page.default(props(`x-${REMOVED_ID}`)))).toBe(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
  });

  it('does not throw from the head for a missing product (the page decides)', async () => {
    expect(await page.generateMetadata(props('nope'))).toEqual({});
    expect(await page.generateMetadata(props(REMOVED_ID))).toEqual({});
  });

  it('gives the descriptive path as canonical and og:url, never with ?v=, for any entry path', async () => {
    vi.stubEnv('STOREFRONT_INDEXING', 'on');
    for (const [segment, query] of [
      [CURRENT, {}],
      [CURRENT, { v: 'variant-1' }],
      [ID, {}],
      [`old-${ID}`, { v: 'x' }],
    ] as const) {
      const metadata = await page.generateMetadata(props(segment, query));
      const url = `https://shop.example/p/${CURRENT}`;
      expect(metadata.alternates?.canonical).toBe(url);
      expect(metadata.openGraph?.url).toBe(url);
      expect(url).not.toContain('?');
    }
  });

  it('puts the same canonical in the JSON-LD offer url', async () => {
    vi.stubEnv('STOREFRONT_INDEXING', 'on');
    const out = (await page.default(props(CURRENT, { v: 'variant-1' }))) as {
      props: { children: { props: { data: unknown } }[] };
    };
    const json = JSON.stringify(out.props.children[0]!.props.data);
    const canonical = `https://shop.example/p/${CURRENT}`;
    expect(json).toContain(`"url":"${canonical}"`);
    expect(json).not.toContain('?v=');
  });
});
