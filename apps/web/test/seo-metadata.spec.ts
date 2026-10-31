import type { Metadata } from 'next';
import { createTranslator } from 'next-intl';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import type { SellerShop } from '../src/storefront/types.ts';

// The request: its Host header and the listed hosts (none on sample data).
const request = vi.hoisted((): { host: string | null; listed: boolean } => ({
  host: 'shop.example',
  listed: true,
}));
// The sample-data lock, switchable per test; the real value is true (src/storefront/source.ts).
const lock = vi.hoisted((): { sampleData: boolean; seller?: SellerShop } => ({
  sampleData: true,
}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(request.host === null ? {} : { host: request.host })),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(createTranslator({ locale: 'en', messages, namespace: namespace as 'store' })),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
}));
vi.mock('../src/storefront/config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  storefrontApiConfig: () =>
    request.listed
      ? {
          apiBaseUrl: 'https://api.shop.example',
          hosts: [{ origin: 'https://shop.example', host: 'shop.example', marketId: 'AU' }],
          clientAddressKey: null,
        }
      : null,
}));
// The pages read the sample whether or not a host is listed: these tests are about head tags.
vi.mock('../src/storefront/source.ts', async (importOriginal) => {
  const actual = await importOriginal<object>();
  const { sampleProduct } = await import('../src/storefront/sample-product.ts');
  const { sampleUnavailableProduct } = await import('../src/storefront/sample-unavailable.ts');
  const { sampleSeller } = await import('../src/storefront/sample-seller.ts');
  const { sampleBrandIndex, sampleBrandPage } = await import('../src/storefront/sample-brands.ts');
  return {
    ...actual,
    get SAMPLE_DATA() {
      return lock.sampleData;
    },
    loadProduct: (id: string) => Promise.resolve(sampleProduct(id)),
    loadUnavailableProduct: (id: string) => Promise.resolve(sampleUnavailableProduct(id)),
    loadSeller: (slug: string) => Promise.resolve(lock.seller ?? sampleSeller(slug)),
    loadBrands: () => Promise.resolve(sampleBrandIndex()),
    loadBrand: (slug: string, page = 1, all = false) =>
      Promise.resolve(sampleBrandPage(slug, page, all ? 24 : 8, all)),
  };
});

// The listing pages read the sample too: their live reads (./listing-source.ts) answer "off".
vi.mock('../src/storefront/listing-source.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  liveCategory: () => Promise.resolve(undefined),
  liveProducts: () => Promise.resolve(undefined),
}));

const { cutDescription, pageTitle, plainText } = await import('../src/seo/defaults.ts');
const { pageMetadata } = await import('../src/seo/metadata.ts');
const layout = await import('../app/layout.tsx');
const accountLayout = await import('../app/account/layout.tsx');

type Query = Record<string, string>;
interface PageModule {
  readonly generateMetadata: (props: {
    params: Promise<Record<string, unknown>>;
    searchParams: Promise<Query>;
  }) => Promise<Metadata>;
}
const page = (load: () => Promise<unknown>) => load() as Promise<PageModule>;

interface Row {
  readonly url: string;
  readonly load: () => Promise<PageModule>;
  readonly params?: Record<string, unknown>;
  readonly title: string;
  /** Canonical path on the host; absent when the page has none. */
  readonly canonical: string;
  readonly noindex: boolean;
  readonly image?: string;
}

const ROWS: readonly Row[] = [
  {
    url: '/',
    load: () => page(() => import('../app/page.tsx')),
    title: 'Mondapac',
    canonical: '/',
    noindex: false,
  },
  {
    url: '/c/meat',
    load: () => page(() => import('../app/c/[category]/[[...sub]]/page.tsx')),
    params: { category: 'meat' },
    title: 'Meat | Mondapac',
    canonical: '/c/meat',
    noindex: false,
  },
  {
    url: '/c/meat/lamb',
    load: () => page(() => import('../app/c/[category]/[[...sub]]/page.tsx')),
    params: { category: 'meat', sub: ['lamb'] },
    title: 'Lamb | Mondapac',
    canonical: '/c/meat/lamb',
    noindex: false,
  },
  {
    url: '/c/meat?page=2',
    load: () => page(() => import('../app/c/[category]/[[...sub]]/page.tsx')),
    params: { category: 'meat' },
    title: 'Meat | Mondapac',
    canonical: '/c/meat?page=2',
    noindex: false,
  },
  {
    url: '/c/meat?special=1',
    load: () => page(() => import('../app/c/[category]/[[...sub]]/page.tsx')),
    params: { category: 'meat' },
    title: 'Meat | Mondapac',
    canonical: '/c/meat',
    noindex: true,
  },
  {
    url: '/c/meat?sort=price-asc',
    load: () => page(() => import('../app/c/[category]/[[...sub]]/page.tsx')),
    params: { category: 'meat' },
    title: 'Meat | Mondapac',
    canonical: '/c/meat',
    noindex: true,
  },
  {
    // A category with no products.
    url: '/c/meals',
    load: () => page(() => import('../app/c/[category]/[[...sub]]/page.tsx')),
    params: { category: 'meals' },
    title: 'Ready meals | Mondapac',
    canonical: '/c/meals',
    noindex: true,
  },
  {
    url: '/p/lamb-shoulder',
    load: () => page(() => import('../app/p/[id]/page.tsx')),
    params: { id: 'lamb-shoulder' },
    title: 'Halal lamb shoulder, 1 kg | Mondapac',
    canonical: '/p/lamb-shoulder',
    noindex: false,
    image: '/placeholders/meat.jpg',
  },
  {
    url: '/s/kedron',
    load: () => page(() => import('../app/s/[slug]/page.tsx')),
    params: { slug: 'kedron' },
    title: 'Kedron Halal Butchers | Mondapac',
    canonical: '/s/kedron',
    noindex: false,
  },
  {
    // A seller with no listed products.
    url: '/s/logan-road',
    load: () => page(() => import('../app/s/[slug]/page.tsx')),
    params: { slug: 'logan-road' },
    title: 'Logan Road Meats | Mondapac',
    canonical: '/s/logan-road',
    noindex: true,
  },
  {
    url: '/sellers',
    load: () => page(() => import('../app/sellers/page.tsx')),
    title: 'Sellers | Mondapac',
    canonical: '/sellers',
    noindex: false,
  },
  {
    url: '/search?q=x',
    load: () => page(() => import('../app/search/page.tsx')),
    title: 'Search | Mondapac',
    canonical: '/search',
    noindex: true,
  },
  {
    url: '/search?q=lamb&sort=name',
    load: () => page(() => import('../app/search/page.tsx')),
    title: 'Results for “lamb” | Mondapac',
    canonical: '/search?q=lamb',
    noindex: true,
  },
  {
    url: '/cart',
    load: () => page(() => import('../app/cart/page.tsx')),
    title: 'Cart | Mondapac',
    canonical: '/cart',
    noindex: true,
  },
  {
    url: '/account',
    load: () => page(() => import('../app/account/(member)/page.tsx')),
    title: 'My account | Mondapac',
    canonical: '/account',
    noindex: true,
  },
  {
    url: '/account/orders',
    load: () => page(() => import('../app/account/(member)/orders/page.tsx')),
    title: 'My orders | Mondapac',
    canonical: '/account/orders',
    noindex: true,
  },
  {
    url: '/brands',
    load: () => page(() => import('../app/brands/page.tsx')),
    title: 'Brands | Mondapac',
    canonical: '/brands',
    noindex: false,
  },
  {
    url: '/brands/saffron-co',
    load: () => page(() => import('../app/brands/[slug]/page.tsx')),
    params: { slug: 'saffron-co' },
    title: 'Saffron & Co | Mondapac',
    canonical: '/brands/saffron-co',
    noindex: false,
  },
  {
    // The full list and its pages are copies of the brand page: canonical to it, out of the index.
    url: '/brands/saffron-co?all=1&page=2',
    load: () => page(() => import('../app/brands/[slug]/page.tsx')),
    params: { slug: 'saffron-co' },
    title: 'Saffron & Co | Mondapac',
    canonical: '/brands/saffron-co',
    noindex: true,
  },
  {
    // A brand with no live product is left out of the index.
    url: '/brands/zahra-kitchen',
    load: () => page(() => import('../app/brands/[slug]/page.tsx')),
    params: { slug: 'zahra-kitchen' },
    title: 'Zahra Kitchen | Mondapac',
    canonical: '/brands/zahra-kitchen',
    noindex: true,
  },
  {
    url: '/offers',
    load: () => page(() => import('../app/offers/page.tsx')),
    title: 'Offers | Mondapac',
    canonical: '/offers',
    noindex: true,
  },
];

function propsOf(row: Row) {
  const query = Object.fromEntries(new URL(row.url, 'https://x').searchParams);
  return { params: Promise.resolve(row.params ?? {}), searchParams: Promise.resolve(query) };
}

const metadataOf = async (row: Row) => (await row.load()).generateMetadata(propsOf(row));

function switchOn(): void {
  vi.stubEnv('STOREFRONT_INDEXING', 'on');
  lock.sampleData = false;
}

afterEach(() => {
  vi.unstubAllEnvs();
  lock.sampleData = true;
  delete lock.seller;
  request.host = 'shop.example';
  request.listed = true;
});

describe('page metadata on a listed host, indexing on', () => {
  it.each(ROWS)('$url', async (row) => {
    switchOn();
    const metadata = await metadataOf(row);
    const url = `https://shop.example${row.canonical}`;
    expect(metadata.title).toEqual({ absolute: row.title });
    expect(metadata.description).toMatch(/\S/);
    expect(metadata.alternates?.canonical).toBe(url);
    expect(String(metadata.metadataBase)).toBe('https://shop.example/');
    expect(metadata.robots).toEqual(row.noindex ? { index: false, follow: true } : undefined);
    expect(metadata.openGraph).toMatchObject({
      type: 'website',
      siteName: 'Mondapac',
      title: row.title,
      description: metadata.description,
      url,
    });
    const image = row.image === undefined ? undefined : `https://shop.example${row.image}`;
    expect(metadata.openGraph?.images).toEqual(image === undefined ? undefined : [{ url: image }]);
    expect(metadata.twitter).toMatchObject({
      card: image === undefined ? 'summary' : 'summary_large_image',
    });
  });

  it('gives every page its own description', async () => {
    // Rows of the same page that differ only in query share one; the paths must not.
    const byPath = new Map<string, unknown>();
    for (const row of ROWS)
      byPath.set(row.canonical.split('?')[0]!, (await metadataOf(row)).description);
    // /search and /search?q=lamb are one page with two descriptions.
    const descriptions = [...byPath.values()];
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('cuts a product description at a word near 155 characters', async () => {
    const metadata = await metadataOf(ROWS.find((row) => row.url === '/p/lamb-shoulder')!);
    expect(Array.from(String(metadata.description)).length).toBeLessThanOrEqual(156);
  });
});

describe('the root rule wins while indexing is off', () => {
  it.each(ROWS)('$url is noindex, nofollow', async (row) => {
    const metadata = await metadataOf(row);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('holds with the env on while sample data is in place', async () => {
    vi.stubEnv('STOREFRONT_INDEXING', 'on');
    for (const row of ROWS)
      expect((await metadataOf(row)).robots).toEqual({ index: false, follow: false });
  });

  it('keeps every account page out of the index from its layout too', () => {
    expect(accountLayout.generateMetadata().robots).toEqual({ index: false, follow: false });
    switchOn();
    expect(accountLayout.generateMetadata().robots).toEqual({ index: false, follow: true });
  });
});

describe('without a listed host', () => {
  it.each([
    ['sample data', () => (request.listed = false)],
    ['an unknown host', () => (request.host = 'other.example')],
    ['no Host header', () => (request.host = null)],
  ])('%s: no canonical, og:url or image', async (_, set) => {
    set();
    switchOn();
    const metadata = await metadataOf(ROWS.find((row) => row.url === '/p/lamb-shoulder')!);
    expect(metadata.title).toEqual({ absolute: 'Halal lamb shoulder, 1 kg | Mondapac' });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.metadataBase).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty('url');
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
  });
});

describe('root layout', () => {
  it('sets the title template and default description', async () => {
    const metadata = await layout.generateMetadata();
    expect(metadata.title).toEqual({ default: 'Mondapac', template: '%s | Mondapac' });
    expect(metadata.description).toBe(messages.store.description);
  });
});

describe('head text', () => {
  it('takes page data as text only', async () => {
    switchOn();
    const metadata = await pageMetadata({
      name: 'Dates <script>alert(1)</script> $& $1',
      description: 'Line one\n\u0007<img src=x onerror=alert(1)>  "quoted"',
      path: '/p/x?y=<b>',
      image: 'javascript:alert(1)',
    });
    expect(metadata.title).toEqual({
      absolute: 'Dates <script>alert(1)</script> $& $1 | Mondapac',
    });
    expect(metadata.description).toBe('Line one <img src=x onerror=alert(1)> "quoted"');
    expect(metadata.alternates?.canonical).toBe('https://shop.example/p/x?y=%3Cb%3E');
    expect(metadata.openGraph).not.toHaveProperty('images');
    // Next renders head tags as React elements, so the text is escaped in the markup.
    const markup = renderToStaticMarkup(
      createElement('meta', { name: 'description', content: metadata.description }),
    );
    expect(markup).toBe(
      '<meta name="description" content="Line one &lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;"/>',
    );
  });

  it.each([
    ['//evil.example/x.jpg', undefined],
    ['http://cdn.example/x.jpg', undefined],
    ['KH', undefined],
    ['/\\evil.example/x.jpg', undefined],
    ['/\t/evil.example/x.jpg', undefined],
    ['/\n/evil.example/x.jpg', undefined],
    ['https://cdn.example/x.jpg', 'https://cdn.example/x.jpg'],
    ['/placeholders/meat.jpg', 'https://shop.example/placeholders/meat.jpg'],
  ])('shares %j as image %j', async (image, shared) => {
    const metadata = await pageMetadata({ name: 'A', description: 'B', path: '/a', image });
    expect(metadata.openGraph?.images).toEqual(
      shared === undefined ? undefined : [{ url: shared }],
    );
  });
});

describe('a store read that does not give everything yet', () => {
  it('keeps the seller out of the index and leaves the about text out', async () => {
    switchOn();
    lock.seller = {
      id: 'new-store',
      name: 'New Store',
      location: 'Greater Brisbane',
      sellingSince: 2026,
      certificates: [],
    };
    const row = ROWS.find((r) => r.url === '/s/kedron')!;
    const metadata = await row.load().then((m) =>
      m.generateMetadata({
        params: Promise.resolve({ slug: 'new-store' }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.description).toBe('New Store, Greater Brisbane.');
  });
});

describe('canonical of a path param', () => {
  it.each(['/p/..', '/s/.', '/account/orders/..'])('%s gets no canonical', async (path) => {
    const metadata = await pageMetadata({ name: 'A', description: 'B', path });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty('url');
  });

  it('cuts a long name in the title', async () => {
    const metadata = await pageMetadata({
      name: `Results for ${'lamb '.repeat(40)}`,
      description: 'B',
      path: '/search',
    });
    const { absolute } = metadata.title as { absolute: string };
    expect(absolute.endsWith('lamb… | Mondapac')).toBe(true);
    expect(Array.from(absolute).length).toBeLessThanOrEqual(61 + ' | Mondapac'.length);
  });
});

describe('defaults', () => {
  it('fills the title template without pattern characters', () => {
    expect(pageTitle('$& $` $1', 'Store')).toBe('$& $` $1 | Store');
  });

  it('collapses whitespace and control characters', () => {
    expect(plainText(' a\n\tb\u0000c  ')).toBe('a b c');
  });

  it('keeps a short description whole', () => {
    expect(cutDescription('Short text.')).toBe('Short text.');
  });

  it('cuts a long description between words, with an ellipsis', () => {
    const text = `${'word '.repeat(40)}end`;
    const cut = cutDescription(text);
    expect(cut.endsWith('word…')).toBe(true);
    expect(Array.from(cut).length).toBeLessThanOrEqual(156);
  });

  it('cuts one long word rather than leave nothing', () => {
    expect(cutDescription('x'.repeat(300))).toBe(`${'x'.repeat(155)}…`);
  });
});
