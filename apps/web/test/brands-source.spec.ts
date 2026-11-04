import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRAND_PAGE_SIZE,
  BRAND_PREVIEW_SIZE,
  brandAllOf,
  brandIndexOf,
  brandOf,
  brandPageNumber,
  brandProductsOf,
  brandProductsPath,
  isBrandSlug,
} from '../src/storefront/brands.ts';
import { brandRefOf } from '../src/storefront/product-detail.ts';
import type { ApiRead } from '../src/storefront/api.ts';
import { loadBrand, loadBrands } from '../src/storefront/source.ts';

// The brand reads: the checks on what the API answers (field by field, untrusted), and the reads of
// source.ts with the API configured: which routes, how a missing brand differs from a fault, and the
// short list against the full list.

const reads = vi.hoisted(() => ({
  answers: new Map<string, ApiRead<unknown>>(),
  paths: [] as string[],
}));

vi.mock('../src/storefront/api.ts', () => ({
  apiGet: (path: string) => {
    reads.paths.push(path);
    return Promise.resolve(reads.answers.get(path.split('?')[0]!) ?? { kind: 'failed' });
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: () =>
    Promise.resolve(Object.assign((code: string) => code, { has: () => true })),
  getLocale: () => Promise.resolve('en'),
}));
vi.mock('../src/storefront/photo-source.ts', () => ({ photoUrls: () => Promise.resolve(null) }));

const ID = '0199aaaa-0000-7000-8000-000000000001';
const brandBody = (over: Record<string, unknown> = {}) => ({
  slug: 'saffron-co',
  name: 'Saffron & Co',
  summary: 'Family spice mill.',
  originCountry: 'AU',
  logoImageId: ID,
  logoAlt: 'Saffron & Co logo',
  headerImageId: ID,
  productCount: 14,
  ...over,
});
const item = (n: number) => ({
  offerId: `0199aaaa-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
  productId: `0199aaaa-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  sellerId: '0199aaaa-0000-7000-8000-000000000003',
  name: `Product ${n}`,
  shortText: null,
  categoryIds: [],
  primaryImage: null,
});
const IMAGE = { src: 'https://img.example/b.jpg', width: 800, height: 400 };

beforeEach(() => {
  reads.answers = new Map();
  reads.paths = [];
});

describe('brand slugs and paging in the URL', () => {
  it.each(['saffron-co', 'a', '7-seas'])('accepts %s', (slug) => {
    expect(isBrandSlug(slug)).toBe(true);
  });
  it.each(['Saffron', 'a_b', '-a', 'a-', 'a--b', '../x', '', 'x'.repeat(81), 3, null])(
    'refuses %j',
    (slug) => {
      expect(isBrandSlug(slug)).toBe(false);
    },
  );
  it('reads the page number and the all switch', () => {
    expect(brandPageNumber('3')).toBe(3);
    for (const bad of [undefined, '0', '101', '-1', '1.5', 'x', ['2']])
      expect(brandPageNumber(bad)).toBe(1);
    expect(brandAllOf('1')).toBe(true);
    expect(brandAllOf('true')).toBe(false);
    expect(brandAllOf(['1'])).toBe(false);
  });
  it('writes the products path with the brand, page and size', () => {
    expect(brandProductsPath('saffron-co', 2, 24)).toBe(
      'search/products?brand=saffron-co&page=2&pageSize=24',
    );
  });
});

describe('the A to Z answer', () => {
  const body = {
    sections: [
      {
        letter: 'A',
        brands: [
          { slug: 'acme-tea', name: 'Acme Tea', logoImageId: ID, logoAlt: 'Acme' },
          { slug: 'apple', name: 'Apple', logoImageId: null, logoAlt: null },
        ],
      },
      {
        letter: '#',
        brands: [{ slug: '7-seas', name: '7 Seas', logoImageId: null, logoAlt: null }],
      },
    ],
    truncated: false,
  };

  it('keeps the sections and brands in order, and has no logo while no image is served', () => {
    expect(brandIndexOf(body)).toEqual({
      sections: [
        {
          letter: 'A',
          brands: [
            { slug: 'acme-tea', name: 'Acme Tea' },
            { slug: 'apple', name: 'Apple' },
          ],
        },
        { letter: '#', brands: [{ slug: '7-seas', name: '7 Seas' }] },
      ],
      truncated: false,
    });
  });

  it('gives a logo its alt text once an image is served for the id', () => {
    const index = brandIndexOf(body, (id) => (id === ID ? IMAGE : undefined));
    expect(index?.sections[0]?.brands[0]?.logo).toEqual({ ...IMAGE, alt: 'Acme' });
    expect(index?.sections[0]?.brands[1]?.logo).toBeUndefined();
  });

  it('drops a bad entry, a repeated slug and an odd letter, and refuses a body that is no list', () => {
    const messy = {
      sections: [
        {
          letter: 'B',
          brands: [
            { slug: 'Bad_Slug', name: 'x' },
            { slug: 'ok', name: '   ' },
            { slug: 'bee', name: 'Bee' },
            { slug: 'bee', name: 'Bee again' },
            'nope',
          ],
        },
        { letter: '<script>', brands: [{ slug: 'z', name: 'Z' }] },
        { letter: 'C', brands: [] },
      ],
      truncated: true,
    };
    expect(brandIndexOf(messy)).toEqual({
      sections: [{ letter: 'B', brands: [{ slug: 'bee', name: 'Bee' }] }],
      truncated: true,
    });
    for (const bad of [null, [], {}, { sections: 'x', truncated: false }, { sections: [] }])
      expect(brandIndexOf(bad)).toBeNull();
    expect(brandIndexOf({ sections: [{ letter: 'A' }], truncated: false })).toBeNull();
  });
});

describe('the brand answer', () => {
  it('maps every field; the country and the pictures only when valid', () => {
    expect(brandOf(brandBody(), (id) => (id === ID ? IMAGE : undefined))).toEqual({
      slug: 'saffron-co',
      name: 'Saffron & Co',
      summary: 'Family spice mill.',
      originCountry: 'AU',
      logo: { ...IMAGE, alt: 'Saffron & Co logo' },
      header: IMAGE,
      productCount: 14,
    });
    expect(
      brandOf(
        brandBody({
          summary: null,
          originCountry: 'au',
          logoImageId: null,
          logoAlt: null,
          headerImageId: 'nope',
        }),
        () => IMAGE,
      ),
    ).toEqual({ slug: 'saffron-co', name: 'Saffron & Co', productCount: 14 });
  });

  it('refuses a body without a valid slug, name or count', () => {
    for (const bad of [
      null,
      'x',
      brandBody({ slug: 'Not A Slug' }),
      brandBody({ name: '' }),
      brandBody({ productCount: -1 }),
      brandBody({ productCount: 1.5 }),
      brandBody({ productCount: '3' }),
    ])
      expect(brandOf(bad)).toBeNull();
  });
});

describe('the products answer', () => {
  it('turns a page into cards, in order, with its page and hasMore', () => {
    const products = brandProductsOf(
      { items: [item(1), item(2)], hasMore: true },
      2,
      new Map(),
      null,
    );
    expect(products.kind).toBe('ok');
    expect(products.kind === 'ok' && products.items.map((card) => card.name)).toEqual([
      'Product 1',
      'Product 2',
    ]);
    expect(products).toMatchObject({ page: 2, hasMore: true });
  });

  it('is a failed read, never half a page, when the body is not a page', () => {
    for (const bad of [null, [], {}, { items: [] }, { items: 'x', hasMore: false }])
      expect(brandProductsOf(bad, 1, new Map(), null)).toEqual({ kind: 'failed', page: 1 });
  });
});

describe('the brand of a product', () => {
  it('is a slug and a name, or nothing', () => {
    expect(brandRefOf({ slug: 'saffron-co', name: 'Saffron & Co' })).toEqual({
      slug: 'saffron-co',
      name: 'Saffron & Co',
    });
    for (const bad of [null, undefined, 'x', {}, { slug: 'Bad_Slug', name: 'x' }, { slug: 'ok' }])
      expect(brandRefOf(bad)).toBeUndefined();
  });
});

describe('the brand reads of the storefront', () => {
  it('reads the A to Z list', async () => {
    reads.answers.set('catalog/brands', {
      kind: 'ok',
      body: {
        sections: [{ letter: 'S', brands: [{ slug: 'saffron-co', name: 'Saffron & Co' }] }],
        truncated: false,
      },
    });
    const index = await loadBrands();
    expect(reads.paths).toEqual(['catalog/brands']);
    expect(index.sections[0]?.brands[0]?.slug).toBe('saffron-co');
  });

  it('throws on a failed or malformed list, so the page shows its error state', async () => {
    await expect(loadBrands()).rejects.toThrow('the brands read failed');
    reads.answers.set('catalog/brands', { kind: 'ok', body: { nope: true } });
    await expect(loadBrands()).rejects.toThrow('the brands read failed');
  });

  const live = (count = 14) => {
    reads.answers.set('catalog/brands/saffron-co', {
      kind: 'ok',
      body: brandBody({ productCount: count }),
    });
    reads.answers.set('search/products', {
      kind: 'ok',
      body: { items: [item(1), item(2)], hasMore: true },
    });
  };

  it('reads the short list under the header: the first 8 products of the brand', async () => {
    live();
    const page = await loadBrand('saffron-co');
    expect(reads.paths).toContain('catalog/brands/saffron-co');
    expect(reads.paths).toContain(
      `search/products?brand=saffron-co&page=1&pageSize=${BRAND_PREVIEW_SIZE}`,
    );
    expect(page?.all).toBe(false);
    expect(page?.brand.productCount).toBe(14);
    expect(page?.products).toMatchObject({ kind: 'ok', page: 1, hasMore: true });
  });

  it('reads page N of 24 for the full list, and ignores the page for the short list', async () => {
    live();
    await loadBrand('saffron-co', 3, true);
    expect(reads.paths).toContain(
      `search/products?brand=saffron-co&page=3&pageSize=${BRAND_PAGE_SIZE}`,
    );
    reads.paths = [];
    await loadBrand('saffron-co', 3, false);
    expect(reads.paths).toContain(
      `search/products?brand=saffron-co&page=1&pageSize=${BRAND_PREVIEW_SIZE}`,
    );
  });

  it("answers no brand for the catalog module's own not-found and for a malformed slug, without a read", async () => {
    reads.answers.set('catalog/brands/gone', {
      kind: 'failed',
      status: 404,
      code: 'brand.not-found',
    });
    expect(await loadBrand('gone')).toBeUndefined();
    reads.paths = [];
    for (const slug of ['../admin', 'Bad_Slug', 'x'.repeat(81), ''])
      expect(await loadBrand(slug)).toBeUndefined();
    expect(reads.paths).toEqual([]);
  });

  it('throws on any other failure, a bare 404 included, so the page shows its error', async () => {
    reads.answers.set('catalog/brands/saffron-co', { kind: 'failed', status: 404 });
    await expect(loadBrand('saffron-co')).rejects.toThrow('the brand read failed');
    reads.answers.set('catalog/brands/saffron-co', {
      kind: 'failed',
      status: 503,
      code: 'brand.unavailable',
    });
    await expect(loadBrand('saffron-co')).rejects.toThrow('the brand read failed');
    reads.answers.set('catalog/brands/saffron-co', { kind: 'ok', body: { slug: 'x' } });
    await expect(loadBrand('saffron-co')).rejects.toThrow('the brand read failed');
  });

  it('keeps the page when only the products read fails: the section says so', async () => {
    live();
    reads.answers.set('search/products', { kind: 'failed', status: 503 });
    const page = await loadBrand('saffron-co');
    expect(page?.brand.name).toBe('Saffron & Co');
    expect(page?.products).toEqual({ kind: 'failed', page: 1 });
  });
});

describe('the brand reads while the API is off', () => {
  beforeEach(() => {
    for (const path of [
      'catalog/brands',
      'catalog/brands/saffron-co',
      'search/products',
      'catalog/categories',
    ])
      reads.answers.set(path, { kind: 'off' });
  });

  it('lists the sample brands A to Z, # last', async () => {
    const index = await loadBrands();
    expect(index.sections.map((section) => section.letter)).toEqual(['A', 'K', 'M', 'P', 'S', 'Z']);
    expect(index.truncated).toBe(false);
  });

  it('answers a sample brand with its products, 8 under the header and 24 to a page in the full list', async () => {
    const short = await loadBrand('saffron-co');
    expect(short?.brand.productCount).toBe(10);
    expect(short?.products).toMatchObject({ kind: 'ok', hasMore: true });
    expect(short?.products.kind === 'ok' && short.products.items).toHaveLength(8);
    const full = await loadBrand('saffron-co', 1, true);
    expect(full?.products.kind === 'ok' && full.products.items).toHaveLength(10);
    expect(full?.products).toMatchObject({ hasMore: false });
  });

  it('answers no brand for a slug the sample does not know', async () => {
    reads.answers.set('catalog/brands/no-such-brand', { kind: 'off' });
    expect(await loadBrand('no-such-brand')).toBeUndefined();
  });
});
