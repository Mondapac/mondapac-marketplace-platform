import { describe, expect, it } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';
import {
  cardOf,
  loadHome,
  moneyOf,
  safeHref,
  sampleFallback,
  storesOf,
} from '../src/storefront/home-source.ts';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';
import type { HomeSection } from '../src/storefront/types.ts';

const MEAT = '0b5e1c3a-0000-4000-8000-000000000001';
const BAKERY = '0b5e1c3a-0000-4000-8000-000000000002';
const LAMB = '0b5e1c3a-0000-4000-8000-000000000003';

const ENV = {};
const NO_SAMPLE = { STOREFRONT_SAMPLE_DATA: 'off' };

/** The default home layout (template system.home, never published) plus one banner. */
const PAGE = {
  kind: 'page',
  page: {
    key: 'home',
    versionNo: 3,
    slots: [
      {
        key: 'top',
        kind: 'modules',
        modules: [
          {
            id: 'b1',
            module: 'banner',
            config: {
              title: 'Ramadan specials',
              subtitle: 'Dates, lamb and sweets',
              image: { ref: 'fruits', alt: 'Fruit' },
              href: '/offers',
              ctaLabel: 'Shop now',
            },
          },
        ],
      },
      {
        key: 'categories',
        kind: 'modules',
        modules: [{ id: 'c1', module: 'category-circles', config: {} }],
      },
      {
        key: 'main',
        kind: 'modules',
        modules: [
          {
            id: 's1',
            module: 'product-shelf',
            config: { source: { kind: 'bestsellers' }, limit: 12 },
          },
          {
            id: 's2',
            module: 'product-shelf',
            config: { source: { kind: 'specials' }, limit: 12 },
          },
          { id: 'n1', module: 'sellers-near-you', config: { limit: 8 } },
        ],
      },
      {
        key: 'end',
        kind: 'modules',
        modules: [{ id: 'i1', module: 'info-strip', config: { items: [{ icon: 'tax' }] } }],
      },
    ],
  },
};

const TREE = {
  locale: 'en-AU',
  categories: [
    { id: MEAT, parentId: null, slug: 'meat', name: 'Meat', depth: 0, position: 0 },
    { id: 'kid', parentId: MEAT, slug: 'lamb', name: 'Lamb', depth: 1, position: 0 },
    { id: BAKERY, parentId: null, slug: 'bakery', name: 'Bakery', depth: 0, position: 1 },
  ],
};

const SPECIAL = {
  offerId: 'o1',
  productId: LAMB,
  sellerId: 'seller-1',
  name: 'Lamb shoulder, 1 kg',
  shortText: null,
  categoryIds: [MEAT],
  variantId: 'v1',
  price: { amount: '2290', currency: 'AUD' },
  regularPrice: { amount: '2490', currency: 'AUD' },
  taxInclusive: true,
  specialEndsAt: '2026-10-30T00:00:00Z',
};

/** Bestsellers carry ids and text only: no price yet. */
const BESTSELLER = { ...SPECIAL, offerId: 'o2', price: undefined, regularPrice: undefined };

type Answers = Readonly<Record<string, unknown>>;

/** A fake `apiGet`: an object answers ok, a number or an absent path fails, OFF is off. */
const OFF = Symbol('off');
let calls: string[] = [];
let read: (path: string) => Promise<ApiRead<unknown>> = () => Promise.resolve({ kind: 'off' });

function serve(answers: Answers) {
  calls = [];
  read = (path) => {
    calls.push(path);
    const answer = answers[path.split('?')[0]!];
    if (answer === OFF) return Promise.resolve({ kind: 'off' });
    if (answer === undefined || typeof answer === 'number') {
      return Promise.resolve({ kind: 'failed' });
    }
    return Promise.resolve({ kind: 'ok', body: answer });
  };
  return calls;
}

const loadWith = (env: Readonly<Record<string, string>>) => loadHome(read, env);

const REAL: Answers = {
  'storefront/pages/home': PAGE,
  'catalog/categories': TREE,
  'search/bestsellers': { items: [BESTSELLER] },
  'search/specials': { items: [SPECIAL, { ...SPECIAL, offerId: 'o3' }] },
};

const shelf = (sections: readonly HomeSection[], title: string) =>
  sections.find((s) => s.kind === 'products' && s.title === title);

describe('home source: configuration', () => {
  it('keeps the sample fallback unless STOREFRONT_SAMPLE_DATA is off', () => {
    expect(sampleFallback({})).toBe(true);
    expect(sampleFallback({ STOREFRONT_SAMPLE_DATA: 'on' })).toBe(true);
    expect(sampleFallback({ STOREFRONT_SAMPLE_DATA: 'off' })).toBe(false);
  });

  it('answers the sample home and reads no shelf while API_BASE_URL is empty', async () => {
    serve({ 'storefront/pages/home': OFF, 'catalog/categories': OFF, 'storefront/slides': OFF });
    const result = await loadWith(NO_SAMPLE);
    expect(calls.sort()).toEqual([
      'catalog/categories',
      'storefront/pages/home',
      'storefront/slides?position=home.hero',
    ]);
    expect(result.sections).toBe(SAMPLE_CONTENT.home);
  });
});

describe('home source: real data', () => {
  it('builds the home from the published layout, the category tree and the specials', async () => {
    serve(REAL);
    const home = await loadWith(NO_SAMPLE);

    expect(calls.sort()).toEqual([
      'catalog/categories',
      'search/bestsellers?limit=12',
      'search/specials?limit=12',
      'sellers/stores?pageSize=8',
      'storefront/pages/home',
      'storefront/slides?position=home.hero',
    ]);

    // The layout's first banner is the hero's stand-in while the library holds no live slide.
    expect(home.sections.map((s) => s.kind)).toEqual([
      'hero',
      'categories',
      'products',
      'products',
    ]);
    expect(home.sections[0]).toEqual({
      kind: 'hero',
      set: {
        position: 'home.hero',
        autoplay: false,
        slides: [
          {
            id: 'b1',
            title: 'Ramadan specials',
            body: 'Dates, lamb and sweets',
            ctaLabel: 'Shop now',
            href: '/offers',
            image: { src: '/placeholders/fruits.jpg', alt: 'Fruit', decorative: false },
            placement: 'start',
            tone: 'dark',
            sponsored: false,
          },
        ],
      },
    });
    expect(home.categories).toEqual([
      {
        id: MEAT,
        code: 'meat',
        name: 'Meat',
        shortName: 'Meat',
        children: [{ code: 'lamb', name: 'Lamb' }],
      },
      { id: BAKERY, code: 'bakery', name: 'Bakery', shortName: 'Bakery', children: [] },
    ]);
    // Two offers of one product make one card; the price and the regular price keep the currency.
    expect(shelf(home.sections, 'Special prices this week')).toEqual({
      kind: 'products',
      title: 'Special prices this week',
      href: '/offers',
      products: [
        {
          id: LAMB,
          name: 'Lamb shoulder, 1 kg',
          sellerName: '',
          category: 'meat',
          price: { amount: 2290, currency: 'AUD' },
          wasPrice: { amount: 2490, currency: 'AUD' },
          certifications: [],
        },
      ],
    });
    // Best sellers have no price in the API yet: the card shows the name only, nothing to add.
    expect(shelf(home.sections, 'Best sellers')).toEqual({
      kind: 'products',
      title: 'Best sellers',
      href: '/best-sellers',
      products: [
        {
          id: LAMB,
          name: 'Lamb shoulder, 1 kg',
          sellerName: '',
          category: 'meat',
          certifications: [],
        },
      ],
    });
    // The store list failed (no answer here): no sellers section, never sample stores.
    expect(home.sellers).toEqual([]);
  });

  it('uses the shelf titles and the categories the layout chose', async () => {
    const page = structuredClone(PAGE);
    page.page.slots[1]!.modules[0]!.config = { categoryIds: [BAKERY] };
    page.page.slots[2]!.modules[1]!.config = {
      title: 'Eid deals',
      source: { kind: 'specials' },
      limit: 4,
    };
    serve({ ...REAL, 'storefront/pages/home': page });
    const home = await loadWith(NO_SAMPLE);
    expect(calls).toContain('search/specials?limit=4');
    expect(home.categories.map((c) => c.code)).toEqual(['bakery']);
    expect(shelf(home.sections, 'Eid deals')).toBeDefined();
  });

  it('fills the shelves the API leaves empty with the sample while the fallback is on', async () => {
    serve({ ...REAL, 'search/bestsellers': { items: [] } });
    const home = await loadWith(ENV);
    const bestsellers = shelf(home.sections, 'Best sellers');
    expect(bestsellers?.kind === 'products' && bestsellers.products[0]?.id).toBe('lamb-shoulder');
    const specials = shelf(home.sections, 'Special prices this week');
    expect(specials?.kind === 'products' && specials.products.map((p) => p.id)).toEqual([LAMB]);
    // Sample stores never stand beside real products.
    expect(home.sections.map((s) => s.kind)).not.toContain('sellers');
  });
});

describe('home source: empty data', () => {
  const EMPTY: Answers = {
    'storefront/pages/home': PAGE,
    'catalog/categories': { locale: 'en-AU', categories: [] },
    'search/bestsellers': { items: [] },
    'search/specials': { items: [] },
  };

  it('leaves out every empty section when the sample fallback is off', async () => {
    serve(EMPTY);
    const home = await loadWith(NO_SAMPLE);
    expect(home.sections.map((s) => s.kind)).toEqual(['hero']);
    expect(home.categories).toEqual([]);
  });

  it('shows the sample categories and shelves when the fallback is on', async () => {
    serve(EMPTY);
    const home = await loadWith(ENV);
    expect(home.categories).toBe(SAMPLE_CONTENT.categories);
    expect(home.sections.map((s) => s.kind)).toEqual([
      'hero',
      'categories',
      'products',
      'products',
    ]);
  });

  it('answers the whole sample home when the layout holds nothing it can show', async () => {
    serve({ ...EMPTY, 'storefront/pages/home': { kind: 'page', page: { slots: [] } } });
    expect((await loadWith(ENV)).sections).toBe(SAMPLE_CONTENT.home);
    expect((await loadWith(NO_SAMPLE)).sections).toEqual([]);
  });
});

describe('home source: API error', () => {
  it('falls back to the sample home when the layout read fails', async () => {
    serve({ ...REAL, 'storefront/pages/home': 503 });
    expect((await loadWith(ENV)).sections).toBe(SAMPLE_CONTENT.home);
    expect(await loadWith(NO_SAMPLE)).toEqual({ sections: [], categories: [], sellers: [] });
  });

  it('keeps the page when one read fails', async () => {
    serve({ ...REAL, 'catalog/categories': 503, 'search/specials': 500 });
    const result = await loadWith(NO_SAMPLE);
    // The categories and specials are gone; the best sellers still show.
    expect(result.sections.map((s) => [s.kind, s.kind === 'products' ? s.title : ''])).toEqual([
      ['hero', ''],
      ['products', 'Best sellers'],
    ]);
  });

  it('treats an answer that is not a page as no layout', async () => {
    serve({ ...REAL, 'storefront/pages/home': { kind: 'redirect', to: '/x' } });
    expect((await loadWith(NO_SAMPLE)).sections).toEqual([]);
  });
});

describe('home source: checks on each answer', () => {
  it('keeps only site paths and https links', () => {
    expect(safeHref('/offers')).toBe('/offers');
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('//evil.test')).toBeUndefined();
    expect(safeHref('/\\evil.test')).toBeUndefined();
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('http://example.com')).toBeUndefined();
  });

  it('needs a currency and whole minor units for a price', () => {
    expect(moneyOf({ amount: '1299', currency: 'NZD' })).toEqual({ amount: 1299, currency: 'NZD' });
    expect(moneyOf({ amount: '12.99', currency: 'AUD' })).toBeUndefined();
    expect(moneyOf({ amount: '1299' })).toBeUndefined();
    expect(moneyOf({ amount: '1299', currency: 'aud' })).toBeUndefined();
  });

  it('shows no card for a price without tax, and no regular price in another currency', () => {
    const slugs = new Map([[MEAT, 'meat']]);
    expect(cardOf({ ...SPECIAL, taxInclusive: false }, slugs)).toBeNull();
    const card = cardOf({ ...SPECIAL, regularPrice: { amount: '9999', currency: 'NZD' } }, slugs);
    expect(card?.wasPrice).toBeUndefined();
    expect(
      cardOf({ ...SPECIAL, price: { amount: '2290', currency: 'NZD' } }, slugs)?.price,
    ).toEqual({
      amount: 2290,
      currency: 'NZD',
    });
  });

  it('drops a banner link that is not a site path, with its button, and an unknown image', async () => {
    const page = structuredClone(PAGE);
    page.page.slots[0]!.modules[0]!.config = {
      title: 'Hello',
      href: 'javascript:alert(1)',
      ctaLabel: 'Go',
      image: { ref: 'unknown', alt: 'x' },
    };
    serve({ ...REAL, 'storefront/pages/home': page });
    const home = await loadWith(NO_SAMPLE);
    expect(home.sections[0]).toEqual({
      kind: 'hero',
      set: {
        position: 'home.hero',
        autoplay: false,
        slides: [{ id: 'b1', title: 'Hello', placement: 'start', tone: 'dark', sponsored: false }],
      },
    });
  });
});

describe('home source: sellers near you', () => {
  const STORES = {
    items: [
      {
        slug: 'kedron-halal',
        name: 'Kedron halal butchers',
        serviceAreaCode: 'greater-brisbane',
        sellingSince: 2026,
        minimumOrder: { amount: '4000', currency: 'AUD' },
      },
      {
        slug: 'nz-bakery',
        name: 'Ponsonby Bakery',
        serviceAreaCode: 'auckland',
        sellingSince: 2025,
        minimumOrder: null,
      },
      {
        slug: 'no-minimum-told',
        name: 'Inala Spice House',
        serviceAreaCode: 'x',
        sellingSince: 2026,
      },
      { slug: 'Bad Slug', name: 'Dropped', serviceAreaCode: 'x', sellingSince: 2026 },
      { slug: 'kedron-halal', name: 'Duplicate', serviceAreaCode: 'x', sellingSince: 2026 },
    ],
    total: 5,
    page: 1,
    pageSize: 8,
  };

  it('shows the stores of the public store list, with their minimum-order line', async () => {
    serve({ ...REAL, 'sellers/stores': STORES });
    const home = await loadWith(NO_SAMPLE);
    expect(home.sections.map((s) => s.kind)).toContain('sellers');
    expect(calls).toContain('sellers/stores?pageSize=8');
    expect(home.sellers).toEqual([
      {
        id: 'kedron-halal',
        name: 'Kedron halal butchers',
        initials: 'KH',
        minimumOrder: 'A$40 minimum order',
      },
      {
        id: 'nz-bakery',
        name: 'Ponsonby Bakery',
        initials: 'PB',
        minimumOrder: 'No minimum order',
      },
      // A minimum that cannot be told shows no line, never "No minimum order".
      { id: 'no-minimum-told', name: 'Inala Spice House', initials: 'IS' },
    ]);
  });

  it('formats a minimum in its own currency', () => {
    const [store] = storesOf({
      items: [
        {
          slug: 'nz',
          name: 'Ponsonby',
          minimumOrder: { amount: '2500', currency: 'NZD' },
        },
      ],
    });
    expect(store?.minimumOrder).toBe('NZ$25 minimum order');
  });

  it('leaves the section out when the list is empty or fails, whatever the fallback says', async () => {
    serve({ ...REAL, 'sellers/stores': { items: [], total: 0, page: 1, pageSize: 8 } });
    expect((await loadWith(ENV)).sections.map((s) => s.kind)).not.toContain('sellers');
    serve({ ...REAL, 'sellers/stores': 503 });
    const failed = await loadWith(ENV);
    expect(failed.sections.map((s) => s.kind)).not.toContain('sellers');
    expect(failed.sellers).toEqual([]);
  });
});

describe('home source: the hero slider', () => {
  const SLIDE = {
    id: '01990000-0000-7000-8000-000000001001',
    kind: 'promotion',
    title: 'Fresh this week',
    body: null,
    ctaLabel: null,
    image: null,
    textPosition: 'start',
    textTone: 'light',
    href: '/offers',
    sponsored: false,
  };
  const SLIDES = {
    position: 'home.hero',
    autoplay: true,
    slides: [SLIDE, { ...SLIDE, id: 'second', title: 'Second' }],
    nextChangeAt: null,
  };
  const hero = (sections: readonly HomeSection[]) => {
    const first = sections[0];
    return first?.kind === 'hero' ? first.set : undefined;
  };

  it('asks for the hero slides of the position with the rest of the page', async () => {
    serve({ ...REAL, 'storefront/slides': SLIDES });
    await loadWith(NO_SAMPLE);
    expect(calls).toContain('storefront/slides?position=home.hero');
  });

  it('shows the live slides in place of the layout banner', async () => {
    serve({ ...REAL, 'storefront/slides': SLIDES });
    const home = await loadWith(NO_SAMPLE);
    const set = hero(home.sections);
    expect(set?.slides.map((s) => s.title)).toEqual(['Fresh this week', 'Second']);
    expect(set?.autoplay).toBe(true);
    // The layout's banner is the stand-in only: it is neither a promo nor a slide here.
    expect(home.sections.map((s) => s.kind)).toEqual([
      'hero',
      'categories',
      'products',
      'products',
    ]);
  });

  it('drops an invalid slide and keeps the rest', async () => {
    serve({
      ...REAL,
      'storefront/slides': {
        ...SLIDES,
        slides: [
          { ...SLIDE, href: 'https://evil.test' },
          { ...SLIDE, id: 'ok', title: 'Kept' },
        ],
      },
    });
    expect(hero((await loadWith(NO_SAMPLE)).sections)?.slides.map((s) => s.title)).toEqual([
      'Kept',
    ]);
  });

  it('falls back to the layout banner as a one-slide slider while the library holds no live slide', async () => {
    serve({ ...REAL, 'storefront/slides': { ...SLIDES, slides: [] } });
    const set = hero((await loadWith(NO_SAMPLE)).sections);
    expect(set?.slides.map((s) => s.title)).toEqual(['Ramadan specials']);
    expect(set?.autoplay).toBe(false);
  });

  it('leaves the later banners of the layout as promos', async () => {
    const page = structuredClone(PAGE);
    page.page.slots[0]!.modules.push({
      id: 'b2',
      module: 'banner',
      config: { title: 'Sell with us', href: '/sell', ctaLabel: 'Join' } as never,
    });
    serve({
      ...REAL,
      'storefront/pages/home': page,
      'storefront/slides': { ...SLIDES, slides: [] },
    });
    const home = await loadWith(NO_SAMPLE);
    expect(home.sections.map((s) => s.kind).slice(0, 2)).toEqual(['hero', 'promos']);
    const promos = home.sections[1];
    expect(promos?.kind === 'promos' && promos.banners.map((b) => [b.id, b.variant])).toEqual([
      ['b2', 'secondary'],
    ]);
  });

  it('draws no hero when there is no live slide and no layout banner', async () => {
    const page = structuredClone(PAGE);
    page.page.slots[0]!.modules = [];
    serve({
      ...REAL,
      'storefront/pages/home': page,
      'storefront/slides': { ...SLIDES, slides: [] },
    });
    expect((await loadWith(NO_SAMPLE)).sections.map((s) => s.kind)).not.toContain('hero');
  });

  it('uses the sample hero when the slides read fails and the fallback is on, not when it is off', async () => {
    const page = structuredClone(PAGE);
    page.page.slots[0]!.modules = [];
    serve({ ...REAL, 'storefront/pages/home': page, 'storefront/slides': 503 });
    expect(hero((await loadWith(ENV)).sections)?.slides.length).toBeGreaterThan(1);
    expect((await loadWith(NO_SAMPLE)).sections.map((s) => s.kind)).not.toContain('hero');
  });

  it('shows the live slides even when the layout read fails', async () => {
    serve({ ...REAL, 'storefront/pages/home': 503, 'storefront/slides': SLIDES });
    const home = await loadWith(NO_SAMPLE);
    expect(home.sections.map((s) => s.kind)).toEqual(['hero']);
    expect((await loadWith(ENV)).sections.filter((s) => s.kind === 'hero')).toHaveLength(1);
  });

  it('has the sample slider while API_BASE_URL is empty', async () => {
    serve({ 'storefront/pages/home': OFF, 'catalog/categories': OFF, 'storefront/slides': OFF });
    const set = hero((await loadWith(NO_SAMPLE)).sections);
    expect(set?.slides.map((s) => s.href)).toEqual(['/offers', '/express', '/certified']);
  });
});
