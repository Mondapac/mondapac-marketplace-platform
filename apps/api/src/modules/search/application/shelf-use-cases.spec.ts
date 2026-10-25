import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { BOUGHT_TOGETHER_DEPTH } from '../domain/shelf-query';
import type { OfferHit } from '../domain/offer-document';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import type { CategorySubtreeSource } from './ports/category-subtree';
import type { OfferSearchReader, OfferSearchRequest } from './ports/offer-search.reader';
import type { ProductImages, PublicImage } from './ports/product-images';
import type { PublicVisibility } from './ports/public-visibility';
import type { PublishedVariants } from './ports/published-variants';
import type { ShelfDocumentsReader } from './ports/shelf-documents.reader';
import type { ShelfSources, ShelfSpecial } from './ports/shelf-sources';
import type { ShelfDependencies } from './shelf-dependencies';
import { FILL_DEPTH, ListBestsellers, RANKED_DEPTH } from './use-cases/list-bestsellers.use-case';
import { ListBoughtTogether } from './use-cases/list-bought-together.use-case';
import { ListSpecials, SPECIALS_DEPTH } from './use-cases/list-specials.use-case';

// The two shelf reads in memory on both Market fixtures (AU in AUD, ZZ in JPY): the order comes
// from ordering's ranking or pricing's specials, the documents from the read model, a short
// best-sellers shelf is filled in browse order, and nothing is shown that catalog and sellers do
// not show now. A source or check that fails is `search.unavailable`.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const ENDS = Temporal.Instant.from('2026-10-20T00:00:00Z');

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const offer = (n: number): Id<'Offer'> => id<'Offer'>(0x1000 + n);
const variant = (n: number): Id<'Variant'> => id<'Variant'>(0x2000 + n);
const SELLER = id<'Seller'>(0x51);
const CATEGORY = id<'Category'>(0xca);
const OTHER_CATEGORY = id<'Category'>(0xcb);
const SUBCATEGORY = id<'Category'>(0xcc);

const hit = (n: number, categoryIds: readonly Id<'Category'>[] = [CATEGORY]): OfferHit => ({
  offerId: offer(n),
  productId: id<'Product'>(0x900 + n),
  sellerId: SELLER,
  name: `Product ${n}`,
  shortText: null,
  categoryIds,
  rank: 0,
});

class MemoryShelves implements ShelfDocumentsReader {
  documents: OfferHit[] = [];
  readonly browsed: number[] = [];
  byOfferIds(_market: MarketContext, offerIds: readonly Id<'Offer'>[]) {
    return Promise.resolve(this.documents.filter((d) => offerIds.includes(d.offerId)));
  }
  byProductId(_market: MarketContext, productId: Id<'Product'>, limit: number) {
    return Promise.resolve(
      this.documents
        .filter((d) => d.productId === productId)
        .sort((a, b) => (a.offerId < b.offerId ? -1 : 1))
        .slice(0, limit),
    );
  }
  browseBySeller() {
    return Promise.resolve([]);
  }
  byProductIds(_market: MarketContext, productIds: readonly Id<'Product'>[], perProduct: number) {
    return Promise.resolve(
      productIds.flatMap((productId) =>
        this.documents
          .filter((d) => d.productId === productId)
          .sort((a, b) => (a.offerId < b.offerId ? -1 : 1))
          .slice(0, perProduct),
      ),
    );
  }
  browseAll(_market: MarketContext, limit: number) {
    this.browsed.push(limit);
    return Promise.resolve(
      [...this.documents].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit),
    );
  }
}

class StubReader implements OfferSearchReader {
  hits: OfferHit[] = [];
  readonly requests: OfferSearchRequest[] = [];
  search(_market: MarketContext, request: OfferSearchRequest) {
    this.requests.push(request);
    return Promise.resolve(this.hits.slice(0, request.limit));
  }
}

class StubSources implements ShelfSources {
  ranked: Id<'Offer'>[] | null = [];
  specials_: ShelfSpecial[] | null = [];
  partners: Id<'Offer'>[] | null = [];
  readonly asked: { kind: string; actor: string; limit: number }[] = [];
  readonly askedFor: Id<'Offer'>[] = [];
  boughtTogetherOfferIds(context: CallContext, offerId: Id<'Offer'>, limit: number) {
    this.asked.push({ kind: 'bought-together', actor: context.actor.kind, limit });
    this.askedFor.push(offerId);
    return Promise.resolve(this.partners);
  }
  bestSellingOfferIds(context: CallContext, limit: number) {
    this.asked.push({ kind: 'bestsellers', actor: context.actor.kind, limit });
    return Promise.resolve(this.ranked);
  }
  specials(context: CallContext, limit: number) {
    this.asked.push({ kind: 'specials', actor: context.actor.kind, limit });
    return Promise.resolve(this.specials_);
  }
}

class StubVisibility implements PublicVisibility {
  hidden = new Set<Id<'Offer'>>();
  failing = false;
  visible(_context: CallContext, offers: readonly { offerId: Id<'Offer'> }[]) {
    if (this.failing) return Promise.resolve(null);
    return Promise.resolve(
      new Set(offers.filter((o) => !this.hidden.has(o.offerId)).map((o) => o.offerId)),
    );
  }
}

class StubImages implements ProductImages {
  images_ = new Map<Id<'Product'>, PublicImage[]>();
  failing = false;
  of() {
    return Promise.resolve(this.failing ? null : new Map(this.images_));
  }
}

class StubVariants implements PublishedVariants {
  unpublished = new Set<Id<'Variant'>>();
  failing = false;
  published(_context: CallContext, offerIds: readonly Id<'Offer'>[]) {
    if (this.failing) return Promise.resolve(null);
    const all = [...Array(0x40).keys()].map((n) => variant(n));
    return Promise.resolve(
      new Map(
        offerIds.map((o) => [o, new Set(all.filter((v) => !this.unpublished.has(v)))] as const),
      ),
    );
  }
}

class StubCategories implements CategorySubtreeSource {
  children = new Map<Id<'Category'>, Id<'Category'>[]>();
  failing = false;
  subtreeOf(_context: CallContext, categoryId: Id<'Category'>) {
    if (this.failing) return Promise.resolve(null);
    return Promise.resolve([categoryId, ...(this.children.get(categoryId) ?? [])]);
  }
}

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('storefront shelves in market %s', (code, currency) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const anonymous = testCallContext(market, 'anonymous', 'shelf-anon-abcdef');
  const system = testCallContext(market, 'system', 'shelf-system-abcd');

  let shelves: MemoryShelves;
  let reader: StubReader;
  let sources: StubSources;
  let visibility: StubVisibility;
  let variants: StubVariants;
  let images: StubImages;
  let categories: StubCategories;
  let deps: ShelfDependencies;

  beforeEach(() => {
    shelves = new MemoryShelves();
    reader = new StubReader();
    sources = new StubSources();
    visibility = new StubVisibility();
    variants = new StubVariants();
    images = new StubImages();
    categories = new StubCategories();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      reader,
      shelves,
      sources,
      visibility,
      policy: new ConfigSearchPolicy(markets),
      variants,
      images,
      categories,
    };
  });

  const special = (n: number, variantNo = n): ShelfSpecial => ({
    offerId: offer(n),
    variantId: variant(variantNo),
    price: { amount: 800n, currency },
    regularPrice: { amount: 1000n, currency },
    taxInclusive: true,
    endsAt: ENDS,
  });

  describe('ListBestsellers', () => {
    const run = (input: object, context = anonymous) =>
      new ListBestsellers(gate, deps).execute(context, input);

    it('shows ranked Offers in rank order, then fills from browse order without repeats', async () => {
      shelves.documents = [hit(1), hit(2), hit(3), hit(4)];
      sources.ranked = [offer(3), offer(9), offer(1)];

      const result = await run({ limit: 4 });

      expect(result).toEqual({
        ok: true,
        value: {
          items: [3, 1, 2, 4].map((n) => {
            const { offerId, productId, sellerId, name, shortText, categoryIds } = hit(n);
            return {
              offerId,
              productId,
              sellerId,
              name,
              shortText,
              categoryIds,
              primaryImage: null,
            };
          }),
        },
      });
      expect(sources.asked).toEqual([
        { kind: 'bestsellers', actor: 'anonymous', limit: RANKED_DEPTH },
      ]);
      expect(shelves.browsed).toEqual([FILL_DEPTH]);
    });

    it('gives each item its first public photo, and none when the photo source fails', async () => {
      shelves.documents = [hit(1), hit(2)];
      sources.ranked = [offer(1), offer(2)];
      const PHOTO = id<'ProductImage'>(0x701);
      images.images_.set(hit(1).productId, [{ imageId: PHOTO, width: 640, height: 480 }]);

      const withPhoto = await run({});
      images.failing = true;
      const without = await run({});

      expect(withPhoto.ok && withPhoto.value.items.map((i) => i.primaryImage)).toEqual([
        { imageId: PHOTO, width: 640, height: 480, alt: 'Product 1' },
        null,
      ]);
      expect(without.ok && without.value.items.map((i) => i.primaryImage)).toEqual([null, null]);
    });

    it('keeps only the category, and fills from that category in browse order', async () => {
      shelves.documents = [hit(1, [OTHER_CATEGORY]), hit(2)];
      sources.ranked = [offer(1), offer(2)];
      reader.hits = [hit(5), hit(2)];

      const result = await run({ category: CATEGORY, limit: 3 });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(2), offer(5)]);
      expect(reader.requests).toEqual([
        expect.objectContaining({
          text: null,
          categoryIds: [CATEGORY],
          limit: FILL_DEPTH,
          offset: 0,
        }),
      ]);
      expect(shelves.browsed).toEqual([]);
    });

    it('counts a subcategory as the category, for the ranked Offers and the fill', async () => {
      categories.children.set(CATEGORY, [SUBCATEGORY]);
      shelves.documents = [hit(1, [SUBCATEGORY]), hit(2, [OTHER_CATEGORY])];
      sources.ranked = [offer(1), offer(2)];
      reader.hits = [hit(5, [SUBCATEGORY])];

      const result = await run({ category: CATEGORY, limit: 3 });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(1), offer(5)]);
      expect(reader.requests[0]?.categoryIds).toEqual([CATEGORY, SUBCATEGORY]);
    });

    it('is unavailable when the category tree cannot be read', async () => {
      categories.failing = true;
      shelves.documents = [hit(1)];
      sources.ranked = [offer(1)];

      expect(await run({ category: CATEGORY })).toEqual({
        ok: false,
        error: { code: 'search.unavailable' },
      });
      expect(reader.requests).toEqual([]);
    });

    it('drops what catalog or sellers no longer show, and caps at the limit', async () => {
      shelves.documents = [hit(1), hit(2), hit(3)];
      sources.ranked = [offer(1), offer(2), offer(3)];
      visibility.hidden.add(offer(1));

      const result = await run({ limit: 1 });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(2)]);
    });

    it('is unavailable when the ranking or the check fails, never an unchecked list', async () => {
      shelves.documents = [hit(1)];
      sources.ranked = null;
      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });

      sources.ranked = [offer(1)];
      visibility.failing = true;
      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });
    });

    it.each([
      [{ limit: 0 }, 'limit'],
      [{ limit: 25 }, 'limit'],
      [{ limit: 1.5 }, 'limit'],
      [{ category: 'not-a-uuid' }, 'category'],
    ])('refuses %j before any read', async (input, path) => {
      const result = await run(input);

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path, code: expect.any(String) as unknown }],
        },
      });
      expect(sources.asked).toEqual([]);
    });

    it('is not for the system actor (rule anonymous)', async () => {
      const result = await run({}, system);

      expect(result.ok).toBe(false);
      expect(sources.asked).toEqual([]);
    });
  });

  describe('ListBoughtTogether', () => {
    const run = (input: object, context = anonymous) =>
      new ListBoughtTogether(gate, deps).execute(context, input);

    it('shows the partners in rank order, never the asked Offer, with no fill', async () => {
      shelves.documents = [hit(1), hit(2), hit(3), hit(4), hit(5)];
      sources.partners = [offer(3), offer(1), offer(9), offer(2)];

      const result = await run({ offer: offer(1), limit: 12 });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(3), offer(2)]);
      expect(sources.asked).toEqual([
        { kind: 'bought-together', actor: 'anonymous', limit: BOUGHT_TOGETHER_DEPTH },
      ]);
      expect(sources.askedFor).toEqual([offer(1)]);
      expect(shelves.browsed).toEqual([]);
    });

    it('answers an empty shelf when the asked Offer is no longer shown or not indexed', async () => {
      shelves.documents = [hit(1), hit(2), hit(3)];
      sources.partners = [offer(2), offer(3)];
      visibility.hidden.add(offer(1));
      expect(await run({ offer: offer(1) })).toEqual({ ok: true, value: { items: [] } });

      visibility.hidden.clear();
      shelves.documents = [hit(2), hit(3)];
      expect(await run({ offer: offer(1) })).toEqual({ ok: true, value: { items: [] } });
    });

    it('answers an empty shelf when nothing is paired', async () => {
      shelves.documents = [hit(1)];

      expect(await run({ offer: offer(1) })).toEqual({ ok: true, value: { items: [] } });
    });

    it('drops what catalog or sellers no longer show, and caps at the limit', async () => {
      shelves.documents = [hit(1), hit(2), hit(3), hit(4)];
      sources.partners = [offer(2), offer(3), offer(4)];
      visibility.hidden.add(offer(2));

      const result = await run({ offer: offer(1), limit: 1 });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(3)]);
    });

    it('is unavailable when the source or the check fails, never an unchecked list', async () => {
      shelves.documents = [hit(1), hit(2)];
      sources.partners = null;
      expect(await run({ offer: offer(1) })).toEqual({
        ok: false,
        error: { code: 'search.unavailable' },
      });

      sources.partners = [offer(2)];
      visibility.failing = true;
      expect(await run({ offer: offer(1) })).toEqual({
        ok: false,
        error: { code: 'search.unavailable' },
      });
    });

    it.each([
      [{}, 'offer'],
      [{ offer: 'not-a-uuid' }, 'offer'],
      [{ offer: 42 }, 'offer'],
      [{ offer: offer(1), limit: 0 }, 'limit'],
      [{ offer: offer(1), limit: 25 }, 'limit'],
      [{ offer: offer(1), limit: 1.5 }, 'limit'],
    ])('refuses %j before any read', async (input, path) => {
      const result = await run(input);

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path, code: expect.any(String) as unknown }],
        },
      });
      expect(sources.asked).toEqual([]);
    });

    it('is not for the system actor (rule anonymous)', async () => {
      const result = await run({ offer: offer(1) }, system);

      expect(result.ok).toBe(false);
      expect(sources.asked).toEqual([]);
    });
  });

  describe('ListSpecials', () => {
    const run = (input: object, context = anonymous) =>
      new ListSpecials(gate, deps).execute(context, input);

    it('shows each Offer once with its special and regular price in the Market currency', async () => {
      shelves.documents = [hit(1), hit(2)];
      sources.specials_ = [special(2), special(1), special(2, 22)];

      const result = await run({});

      expect(result.ok && result.value.items).toEqual([
        expect.objectContaining({
          offerId: offer(2),
          variantId: variant(2),
          price: { amount: 800n, currency },
          regularPrice: { amount: 1000n, currency },
          taxInclusive: true,
          specialEndsAt: ENDS,
        }),
        expect.objectContaining({ offerId: offer(1), variantId: variant(1) }),
      ]);
      expect(sources.asked).toEqual([
        { kind: 'specials', actor: 'anonymous', limit: SPECIALS_DEPTH },
      ]);
    });

    it('gives each special its first public photo', async () => {
      shelves.documents = [hit(1)];
      sources.specials_ = [special(1)];
      const PHOTO = id<'ProductImage'>(0x701);
      images.images_.set(hit(1).productId, [{ imageId: PHOTO, width: 640, height: 480 }]);

      const result = await run({});

      expect(result.ok && result.value.items[0]?.primaryImage).toEqual({
        imageId: PHOTO,
        width: 640,
        height: 480,
        alt: 'Product 1',
      });
    });

    it('leaves out unindexed, other-category and hidden Offers', async () => {
      shelves.documents = [hit(1), hit(2, [OTHER_CATEGORY]), hit(3)];
      sources.specials_ = [special(1), special(2), special(3), special(4)];
      visibility.hidden.add(offer(3));

      const result = await run({ category: CATEGORY });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(1)]);
    });

    it('keeps Offers of a subcategory when a category is asked', async () => {
      categories.children.set(CATEGORY, [SUBCATEGORY]);
      shelves.documents = [hit(1, [SUBCATEGORY]), hit(2, [OTHER_CATEGORY])];
      sources.specials_ = [special(1), special(2)];

      const result = await run({ category: CATEGORY });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(1)]);
    });

    it('is unavailable when the category tree cannot be read', async () => {
      categories.failing = true;
      shelves.documents = [hit(1)];
      sources.specials_ = [special(1)];

      expect(await run({ category: CATEGORY })).toEqual({
        ok: false,
        error: { code: 'search.unavailable' },
      });
    });

    it('skips a key whose Variant is not published and uses the Offer next key', async () => {
      shelves.documents = [hit(1)];
      sources.specials_ = [special(1, 10), special(1, 11)];
      variants.unpublished.add(variant(10));

      const result = await run({});

      expect(result.ok && result.value.items.map((i) => i.variantId)).toEqual([variant(11)]);
    });

    it('is unavailable when the published-variant check fails', async () => {
      shelves.documents = [hit(1)];
      sources.specials_ = [special(1)];
      variants.failing = true;

      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });
    });

    it('is unavailable when pricing or the check fails', async () => {
      sources.specials_ = null;
      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });

      sources.specials_ = [special(1)];
      shelves.documents = [hit(1)];
      visibility.failing = true;
      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });
    });
  });
});
