import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemorySlides } from '../../../../test/support/memory-slide-repository';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AccessDeclaration } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { storedContent } from '../domain/slides';
import type { SlideContent } from '../domain/slides';
import type { LinkTargets, LiveCategoryRow } from './ports/link-targets';
import { targetKey, type SlideTargets } from './ports/slide-targets';
import type { SlideRecord } from './ports/slide.repository';
import type { StorefrontDependencies } from './storefront-dependencies';
import { ViewPublishedStorefrontSlides } from './use-cases/view-published-slides.use-case';

// The public slider read in memory on both Market fixtures: only live, in-window, approved
// slides of the request's Market, with link targets alive in that Market.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-23T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const hours = (n: number) => T0.add({ hours: n });

const TOP = id<'Category'>(0xc1).toString();
const CHILD = id<'Category'>(0xc2).toString();
const DEEP = id<'Category'>(0xc3).toString();
const PRODUCT = id<'Product'>(0xb1).toString();
const SELLER_OK = id<'Seller'>(0x51).toString();
const SELLER_SUSPENDED = id<'Seller'>(0x52).toString();
const PAGE = id<'StorefrontPage'>(0xd1).toString();

/** What each Market's owners know; a fixture of one Market knows nothing of the other's ids. */
interface World {
  categories: LiveCategoryRow[];
  products: Set<string>;
  sellers: Map<string, string>;
}
const worlds = new Map<string, World>();
const worldOf = (code: string): World => {
  let world = worlds.get(code);
  if (world === undefined) {
    world = { categories: [], products: new Set(), sellers: new Map() };
    worlds.set(code, world);
  }
  return world;
};
const targets: SlideTargets & { down: boolean } = {
  down: false,
  live: (c, wanted) => {
    if (targets.down) return Promise.resolve(null);
    const world = worldOf(c.market.marketId);
    return Promise.resolve(
      new Set(
        wanted
          .filter((t) =>
            t.type === 'category'
              ? world.categories.some((row) => row.id === t.id)
              : t.type === 'product'
                ? world.products.has(t.id)
                : world.sellers.has(t.id),
          )
          .map(targetKey),
      ),
    );
  },
};
const links: LinkTargets = {
  categories: (c) => Promise.resolve(worldOf(c.market.marketId).categories),
  sellerSlugs: (c, ids) =>
    Promise.resolve(
      new Map(
        ids.flatMap((s) => {
          const slug = worldOf(c.market.marketId).sellers.get(s);
          return slug === undefined ? [] : [[s, slug] as const];
        }),
      ),
    ),
};

const content = (over: Partial<SlideContent> = {}): SlideContent => ({
  title: 'Fresh this week',
  body: 'Halal lamb',
  ctaLabel: null,
  image: null,
  textPosition: 'start',
  textTone: 'light',
  link: null,
  ...over,
});

describe.each([
  ['AU', 'ZZ'],
  ['ZZ', 'AU'],
] as const)('public slides in market %s (other market %s)', (code, otherCode) => {
  const market = testMarketContext(code, 'default');
  const otherMarket = testMarketContext(otherCode, 'default');
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, {
    check: (_c: CallContext, declaration: AccessDeclaration) =>
      Promise.resolve(
        declaration.rule.kind === 'anonymous'
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  });
  const buyer = testCallContext(market, 'anonymous', `pub-${code.toLowerCase()}-0001`);
  const otherBuyer = testCallContext(otherMarket, 'anonymous', `pub-${otherCode.toLowerCase()}-01`);
  let slides: MemorySlides;
  let read: ViewPublishedStorefrontSlides;
  let next: number;
  let setLinks: LinkTargets;
  const pagesStub = {
    findPage: (_m: unknown, pageId: string) =>
      Promise.resolve(
        pageId === PAGE
          ? {
              id: PAGE,
              kind: 'dynamic',
              slug: 'ramadan',
              archivedAt: null,
              startsAt: null,
              endsAt: null,
            }
          : null,
      ),
    findPublished: (_m: unknown, pageId: string) =>
      Promise.resolve(pageId === PAGE ? { versionNo: 1 } : null),
  };

  beforeEach(() => {
    worlds.clear();
    targets.down = false;
    for (const c of [code, otherCode]) {
      worldOf(c).categories = [
        { id: TOP, parentId: null, slug: 'meat' },
        { id: CHILD, parentId: TOP, slug: 'lamb' },
        { id: DEEP, parentId: CHILD, slug: 'chops' },
      ];
    }
    clock.set(T0);
    slides = new MemorySlides();
    next = 1;
    setLinks = links;
    const deps = {
      unitOfWork: new FakeUnitOfWork(),
      pages: pagesStub as never,
      slides,
      targets,
      links: setLinks,
      audit: undefined as never,
      ids: new SequenceIdGenerator(clock),
      clock,
    } as StorefrontDependencies;
    read = new ViewPublishedStorefrontSlides(gate, deps);
  });

  interface Seed {
    position?: string;
    startsAt?: Temporal.Instant;
    endsAt?: Temporal.Instant;
    state?: SlideRecord['state'];
    pinned?: boolean;
    sortOrder?: number;
    scope?: 'all' | 'category' | 'product' | 'seller' | 'page';
    scopeId?: string | null;
    includeSubcategories?: boolean;
    autoplay?: boolean;
    content?: Partial<SlideContent>;
    market?: typeof market;
    keepPlacement?: boolean;
  }
  /** One approved slide with one placement, as the approval flow leaves it. */
  function seed(over: Seed = {}): string {
    const n = next++;
    const target = over.market ?? market;
    const slideId = id<'StorefrontSlide'>(0x1000 + n);
    const versionId = id<'StorefrontSlideVersion'>(0x2000 + n);
    const startsAt = over.startsAt ?? hours(-1);
    const endsAt = over.endsAt ?? hours(48);
    slides.slides.set(slideId, {
      id: slideId,
      kind: 'promotion',
      internalName: `slide ${n}`,
      state: over.state ?? 'approved',
      startsAt,
      endsAt,
      pinned: over.pinned ?? false,
      sponsored: false,
      liveVersionId: versionId,
      draftVersionId: null,
      submittedVersionId: null,
      createdAt: T0,
      updatedAt: T0,
      marketId: target.marketId,
    });
    slides.versionRows.set(versionId, {
      id: versionId,
      slideId,
      versionNo: 1,
      internalName: `slide ${n}`,
      content: storedContent(content({ title: `Slide ${n}`, ...over.content })),
      placements: [],
      startsAt,
      endsAt,
      pinned: over.pinned ?? false,
      sponsored: false,
      createdAt: T0,
      createdBy: id<'Account'>(1),
      approvedBy: id<'Account'>(2),
      approvedAt: T0,
      marketId: target.marketId,
    });
    slides.placements.push({
      id: id<'StorefrontSlidePlacement'>(0x3000 + n),
      slideId,
      position: over.position ?? 'home.hero',
      scope: over.scope ?? 'all',
      scopeId: over.scopeId ?? null,
      includeSubcategories: over.includeSubcategories ?? false,
      sortOrder: over.sortOrder ?? 0,
      autoplay: over.autoplay ?? true,
      startsAt,
      endsAt,
      marketId: target.marketId,
    });
    return slideId;
  }

  const titles = async (ctx: CallContext = buyer, query: unknown = { position: 'home.hero' }) => {
    const result = await read.execute(ctx, query);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };

  it('declares the anonymous rule under its own name', () => {
    expect(ViewPublishedStorefrontSlides.access).toEqual({
      name: 'storefront.view-published-slides',
      rule: { kind: 'anonymous' },
    });
  });

  it('serves the most specific placement of a slide, so a reorder never changes its autoplay', async () => {
    const page = id<'StorefrontPage'>(0x77).toString();
    const slideId = seed({ position: 'landing.top', autoplay: true, sortOrder: 0 });
    const own = slides.placements.find((p) => p.slideId === slideId)!;
    slides.placements.push({
      ...own,
      id: id<'StorefrontSlidePlacement'>(0x3999),
      scope: 'page',
      scopeId: page,
      autoplay: false,
      sortOrder: 5,
    });
    const served = async () => (await titles(buyer, { position: 'landing.top', page })).autoplay;
    // The page placement wins although its sort order is the larger one...
    expect(await served()).toBe(false);
    // ...and a reorder (sort orders rewritten either way) does not change that.
    for (const [all, specific] of [
      [9, 0],
      [0, 9],
    ] as const) {
      slides.placements.forEach((p, i) => {
        if (p.slideId === slideId) {
          slides.placements[i] = { ...p, sortOrder: p.scope === 'all' ? all : specific };
        }
      });
      expect(await served()).toBe(false);
    }
  });

  it('answers the live slides sorted: pinned first, then sort order', async () => {
    seed({ sortOrder: 5 });
    seed({ sortOrder: 1 });
    seed({ pinned: true, sortOrder: 9 });
    const view = await titles();
    expect(view.slides.map((s) => s.title)).toEqual(['Slide 3', 'Slide 2', 'Slide 1']);
    expect(view.position).toBe('home.hero');
    expect(view.autoplay).toBe(true);
  });

  it('never answers a slide of the other Market, and the other Market sees only its own', async () => {
    seed();
    seed({ market: otherMarket, content: { title: 'Other market only' } });
    expect((await titles()).slides.map((s) => s.title)).toEqual(['Slide 1']);
    expect((await titles(otherBuyer)).slides.map((s) => s.title)).toEqual(['Other market only']);
  });

  it('leaves out paused, archived, ended and not yet started slides', async () => {
    seed({ state: 'paused' });
    seed({ state: 'archived' });
    seed({ startsAt: hours(-48), endsAt: hours(-1) });
    seed({ startsAt: hours(1), endsAt: hours(24) });
    const live = seed();
    const view = await titles();
    expect(view.slides.map((s) => s.id)).toEqual([live]);
  });

  it('stops serving a slide the moment its placements are removed (pause)', async () => {
    const slide = seed();
    expect((await titles()).slides).toHaveLength(1);
    await slides.replacePlacements(market, slide as Id<'StorefrontSlide'>, []);
    expect((await titles()).slides).toHaveLength(0);
  });

  it('serves a slide from the second it starts and not from the second it ends', async () => {
    seed({ startsAt: hours(1), endsAt: hours(2) });
    expect((await titles()).slides).toHaveLength(0);
    clock.set(hours(1));
    expect((await titles()).slides).toHaveLength(1);
    clock.set(hours(2));
    expect((await titles()).slides).toHaveLength(0);
  });

  it('caps the answer at the most the position allows', async () => {
    for (let i = 0; i < 10; i += 1) seed();
    expect((await titles()).slides).toHaveLength(8);
    for (let i = 0; i < 6; i += 1) seed({ position: 'home.mid' });
    const mid = await titles(buyer, { position: 'home.mid' });
    expect(mid.slides).toHaveLength(4);
    expect(mid.autoplay).toBe(false);
  });

  it('autoplays only when every slide asks for it', async () => {
    seed();
    seed({ autoplay: false });
    expect((await titles()).autoplay).toBe(false);
  });

  describe('links', () => {
    it('resolves each kind of target to a site path', async () => {
      const world = worldOf(code);
      world.products.add(PRODUCT);
      world.sellers.set(SELLER_OK, 'halal-hub');
      seed({ content: { link: { type: 'category', id: TOP } } });
      seed({ content: { link: { type: 'category', id: CHILD } } });
      seed({ content: { link: { type: 'product', id: PRODUCT } } });
      seed({ content: { link: { type: 'seller', id: SELLER_OK } } });
      seed({ content: { link: { type: 'page', id: PAGE } } });
      seed({ content: { link: { type: 'search', id: 'specials' } } });
      seed();
      const view = await titles();
      expect(view.slides.map((s) => s.href)).toEqual([
        '/c/meat',
        '/c/meat/lamb',
        `/p/${PRODUCT}`,
        '/s/halal-hub',
        '/l/ramadan',
        '/offers',
        null,
      ]);
    });

    it('drops a slide whose seller is suspended', async () => {
      worldOf(code).sellers.set(SELLER_OK, 'halal-hub');
      seed({ content: { link: { type: 'seller', id: SELLER_SUSPENDED } } });
      const kept = seed({ content: { link: { type: 'seller', id: SELLER_OK } } });
      expect((await titles()).slides.map((s) => s.id)).toEqual([kept]);
    });

    it('drops a slide whose target is dead: unknown, unpublished, too deep or not prepared', async () => {
      seed({ content: { link: { type: 'category', id: id<'Category'>(0xff).toString() } } });
      seed({ content: { link: { type: 'category', id: DEEP } } });
      seed({ content: { link: { type: 'product', id: PRODUCT } } });
      seed({ content: { link: { type: 'page', id: id<'StorefrontPage'>(0xfe).toString() } } });
      seed({ content: { link: { type: 'search', id: 'no-such-search' } } });
      expect((await titles()).slides).toEqual([]);
    });

    it('drops a Market A product id stored in a Market B slide', async () => {
      // The product is live in the request Market of A only; B's owner does not know it.
      const otherId = id<'Product'>(0xb2).toString();
      worldOf(code).products.add(otherId);
      seed({ market: otherMarket, content: { link: { type: 'product', id: otherId } } });
      const own = seed({ content: { link: { type: 'product', id: otherId } } });
      expect((await titles()).slides.map((s) => s.id)).toEqual([own]);
      expect((await titles(otherBuyer)).slides).toEqual([]);
    });

    it('drops a slide whose content no longer passes the checks', async () => {
      const slide = seed();
      const version = [...slides.versionRows.values()].find((v) => v.slideId === slide)!;
      slides.versionRows.set(version.id, { ...version, content: { title: '<b>x</b>' } });
      expect((await titles()).slides).toEqual([]);
    });

    it('drops what depends on an owner that cannot answer and does not let it be cached', async () => {
      seed({ content: { link: { type: 'product', id: PRODUCT } } });
      const plain = seed();
      targets.down = true;
      const view = await read.execute(buyer, { position: 'home.hero' });
      expect(view.ok && view.value.slides.map((s) => s.id)).toEqual([plain]);
      expect(view.ok && view.value.maxAgeSeconds).toBe(0);
    });
  });

  describe('scope', () => {
    it('shows a category slide on that category and, when asked, on its subcategories', async () => {
      const exact = seed({ position: 'category.top', scope: 'category', scopeId: TOP });
      const tree = seed({
        position: 'category.top',
        scope: 'category',
        scopeId: TOP,
        includeSubcategories: true,
      });
      const everywhere = seed({ position: 'category.top' });
      const ids = async (category: string) =>
        (await titles(buyer, { position: 'category.top', category })).slides.map((s) => s.id);
      expect(await ids(TOP)).toEqual([exact, tree, everywhere]);
      expect(await ids(CHILD)).toEqual([tree, everywhere]);
      expect(await ids(id<'Category'>(0xfd).toString())).toEqual([everywhere]);
      expect((await titles(buyer, { position: 'category.top' })).slides.map((s) => s.id)).toEqual([
        everywhere,
      ]);
    });

    it('shows a seller-scoped slide only for a seller that may sell', async () => {
      worldOf(code).sellers.set(SELLER_OK, 'halal-hub');
      const ok = seed({ position: 'product.below-details', scope: 'seller', scopeId: SELLER_OK });
      seed({ position: 'product.below-details', scope: 'seller', scopeId: SELLER_SUSPENDED });
      const view = await titles(buyer, {
        position: 'product.below-details',
        seller: SELLER_OK,
      });
      expect(view.slides.map((s) => s.id)).toEqual([ok]);
      const suspended = await titles(buyer, {
        position: 'product.below-details',
        seller: SELLER_SUSPENDED,
      });
      expect(suspended.slides).toEqual([]);
    });
  });

  describe('timing', () => {
    it('names the nearest start or end ahead and keeps the cache within it', async () => {
      seed({ startsAt: hours(-5), endsAt: hours(10) });
      seed({ startsAt: hours(3), endsAt: hours(9) });
      const view = await titles();
      expect(view.nextChangeAt?.toString()).toBe(hours(3).toString());
      expect(view.maxAgeSeconds).toBe(60);
      clock.set(hours(3).subtract({ seconds: 20 }));
      const soon = await titles();
      expect(soon.maxAgeSeconds).toBe(20);
      clock.set(hours(3).subtract({ milliseconds: 500 }));
      expect((await titles()).maxAgeSeconds).toBe(0);
    });

    it('has no next change when nothing is ahead', async () => {
      expect((await titles()).nextChangeAt).toBeNull();
      expect((await titles()).maxAgeSeconds).toBe(60);
    });
  });

  describe('the request', () => {
    it.each([
      [{}, 'position'],
      [{ position: 'checkout.top' }, 'position'],
      [{ position: 'home.hero', category: TOP }, 'category'],
      [{ position: 'category.top', category: 'not-a-uuid' }, 'category'],
      [{ position: 'home.hero', colour: 'red' }, 'colour'],
      [{ position: ['home.hero', 'home.mid'] }, 'position'],
    ])('refuses %j', async (query, path) => {
      const result = await read.execute(buyer, query);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('validation.failed');
        expect(
          (result.error as { fields: { path: string }[] }).fields.map((f) => f.path),
        ).toContain(path);
      }
    });
  });
});
