import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { OfferHit } from '../domain/offer-document';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import type { PersonalSignals, PersonalViews, PrivacySignals } from './ports/personal-signals';
import type { ProductImages, PublicImage } from './ports/product-images';
import type { PublicVisibility } from './ports/public-visibility';
import type { PublishedVariants } from './ports/published-variants';
import type { ShelfDocumentsReader } from './ports/shelf-documents.reader';
import type { ShelfSources } from './ports/shelf-sources';
import type { RecommendationDependencies } from './recommendation-dependencies';
import { ListForYouGuest } from './use-cases/list-for-you-guest.use-case';
import { ListForYou } from './use-cases/list-for-you.use-case';
import { ListRecentlyViewedGuest } from './use-cases/list-recently-viewed-guest.use-case';
import { ListRecentlyViewed } from './use-cases/list-recently-viewed.use-case';
import { itemOf, RANKED_DEPTH } from './use-cases/list-bestsellers.use-case';

// "For you" and "recently viewed" in memory on both Market fixtures (personalization 1d-1): the
// views come from engagement's facade (empty under Global Privacy Control, with the switch off or
// without consent: engagement's own tests cover that), "for you" ranks the Market's best sellers
// by the viewed categories without any certified category, falls back to the plain best sellers,
// de-duplicates and re-checks every Offer; "recently viewed" keeps the viewed order and drops what
// is not sellable. A failed ordering source or check is `search.unavailable`.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const offer = (n: number): Id<'Offer'> => id<'Offer'>(0x1000 + n);
const product = (n: number): Id<'Product'> => id<'Product'>(0x900 + n);
const category = (n: number): Id<'Category'> => id<'Category'>(0xc00 + n);
const SELLER = id<'Seller'>(0x51);
const GROCERY = category(1);
const MEAT = category(2);
const HALAL = category(3);
const QUIET: PrivacySignals = { globalPrivacyControl: false, consent: true, guestToken: null };

const hit = (n: number, categoryIds: readonly Id<'Category'>[], productNo = n): OfferHit => ({
  offerId: offer(n),
  productId: product(productNo),
  sellerId: SELLER,
  name: `Product ${n}`,
  shortText: null,
  categoryIds,
  rank: 0,
});

class MemoryShelves implements ShelfDocumentsReader {
  documents: OfferHit[] = [];
  byOfferIds(_market: MarketContext, offerIds: readonly Id<'Offer'>[]) {
    return Promise.resolve(this.documents.filter((d) => offerIds.includes(d.offerId)));
  }
  byProductId(_market: MarketContext, productId: Id<'Product'>, limit: number) {
    return Promise.resolve(this.documents.filter((d) => d.productId === productId).slice(0, limit));
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
    return Promise.resolve(
      [...this.documents].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit),
    );
  }
  browseBySeller() {
    return Promise.resolve([]);
  }
}

class StubImages implements ProductImages {
  images_ = new Map<Id<'Product'>, PublicImage[]>();
  failing = false;
  of() {
    return Promise.resolve(this.failing ? null : new Map(this.images_));
  }
}

class StubSources implements ShelfSources {
  ranked: Id<'Offer'>[] | null = [];
  readonly asked: string[] = [];
  bestSellingOfferIds(context: CallContext, limit: number) {
    this.asked.push(`${context.actor.kind}:${limit}`);
    return Promise.resolve(this.ranked);
  }
  specials() {
    return Promise.resolve([]);
  }
  boughtTogetherOfferIds() {
    return Promise.resolve([]);
  }
}

class StubVisibility implements PublicVisibility {
  hidden = new Set<Id<'Offer'>>();
  failing = false;
  checked: Id<'Offer'>[] = [];
  visible(_context: CallContext, offers: readonly { offerId: Id<'Offer'> }[]) {
    this.checked = offers.map((o) => o.offerId);
    if (this.failing) return Promise.resolve(null);
    return Promise.resolve(
      new Set(offers.filter((o) => !this.hidden.has(o.offerId)).map((o) => o.offerId)),
    );
  }
}

class StubSignals implements PersonalSignals {
  views: PersonalViews | null = { productIds: [], categoryIds: [] };
  certified: ReadonlySet<Id<'Category'>> | null = new Set();
  readonly viewsAsked: { actor: string; privacy: PrivacySignals }[] = [];
  certifiedAsked = 0;
  recentViews(context: CallContext, privacy: PrivacySignals) {
    this.viewsAsked.push({ actor: context.actor.kind, privacy });
    return Promise.resolve(this.views);
  }
  certifiedCategoryIds() {
    this.certifiedAsked += 1;
    return Promise.resolve(this.certified);
  }
}

class StubVariants implements PublishedVariants {
  published(_context: CallContext, offerIds: readonly Id<'Offer'>[]) {
    return Promise.resolve(new Map(offerIds.map((o) => [o, new Set<Id<'Variant'>>()] as const)));
  }
}

describe.each([['AU'], ['ZZ']] as const)('personal shelves in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const guest = testCallContext(market, 'anonymous', 'rec-guest-abcdef');
  const customer = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: id<'Account'>(0xa1),
      sessionId: id<'Session'>(0x61),
      sellerId: null,
    }),
    'rec-customer-abcd',
  );

  let shelves: MemoryShelves;
  let sources: StubSources;
  let visibility: StubVisibility;
  let signals: StubSignals;
  let images: StubImages;
  let deps: RecommendationDependencies;

  beforeEach(() => {
    shelves = new MemoryShelves();
    sources = new StubSources();
    visibility = new StubVisibility();
    signals = new StubSignals();
    images = new StubImages();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      reader: { search: () => Promise.resolve([]) },
      shelves,
      sources,
      visibility,
      policy: new ConfigSearchPolicy(markets),
      variants: new StubVariants(),
      images,
      signals,
    };
  });

  const forYou = (input: object = {}, context = customer) =>
    new ListForYou(gate, deps).execute(context, { privacy: QUIET, ...input });
  const forYouGuest = (input: object = {}) =>
    new ListForYouGuest(gate, deps).execute(guest, { privacy: QUIET, ...input });
  const recent = (input: object = {}, context = customer) =>
    new ListRecentlyViewed(gate, deps).execute(context, { privacy: QUIET, ...input });
  const recentGuest = (input: object = {}) =>
    new ListRecentlyViewedGuest(gate, deps).execute(guest, { privacy: QUIET, ...input });
  const offersOf = (result: {
    ok: boolean;
    value?: { readonly items: readonly { offerId: string }[] };
  }) => result.value?.items.map((item) => item.offerId);

  describe('for you', () => {
    beforeEach(() => {
      // Best sellers in rank order: 1 (grocery), 2 (meat), 3 (grocery), 4 (halal meat), 5 (meat).
      shelves.documents = [
        hit(1, [GROCERY]),
        hit(2, [MEAT]),
        hit(3, [GROCERY]),
        hit(4, [MEAT, HALAL]),
        hit(5, [MEAT]),
        hit(6, [GROCERY]),
      ];
      sources.ranked = [1, 2, 3, 4, 5].map(offer);
    });

    it('ranks the best sellers in the viewed categories first, then the rest, then the fill', async () => {
      signals.views = { productIds: [], categoryIds: [MEAT] };

      const result = await forYou();

      expect(offersOf(result)).toEqual([2, 4, 5, 1, 3, 6].map(offer));
      expect(sources.asked).toEqual([`authenticated:${RANKED_DEPTH}`]);
    });

    it('reads the categories of every newest viewed product, however many Offers another has', async () => {
      shelves.documents = [
        ...shelves.documents,
        ...[...Array(300).keys()].map((n) => hit(3000 + n, [GROCERY], 2)),
        hit(7000, [category(9)], 9),
      ];
      sources.ranked = [offer(1), offer(2), offer(7000)];
      signals.views = { productIds: [product(2), product(9)], categoryIds: [] };

      const items = offersOf(await forYou({ limit: 2 }));

      // Product 9 sorts last and its category still counts: its Offer is lifted over offer 1,
      // which plain rank order would have shown second.
      expect(items).toEqual([offer(2), offer(7000)]);
    });

    it('also reads the categories of the viewed products', async () => {
      signals.views = { productIds: [product(2)], categoryIds: [] };

      expect(offersOf(await forYou({ limit: 3 }))).toEqual([2, 4, 5].map(offer));
    });

    it('never uses a certified category as a signal', async () => {
      signals.views = { productIds: [product(4)], categoryIds: [HALAL, GROCERY] };
      signals.certified = new Set([HALAL, MEAT]);

      // Only GROCERY counts: the halal and meat views are ignored, so 4 (meat and halal) is not lifted.
      expect(offersOf(await forYou())).toEqual([1, 3, 2, 4, 5, 6].map(offer));
      expect(signals.certifiedAsked).toBe(1);
    });

    it('uses no category signal when the certified categories cannot be read', async () => {
      signals.views = { productIds: [], categoryIds: [MEAT] };
      signals.certified = null;

      expect(offersOf(await forYou())).toEqual([1, 2, 3, 4, 5, 6].map(offer));
    });

    it('falls back to the Market best sellers when there are no views', async () => {
      const plain = await forYou();

      expect(offersOf(plain)).toEqual([1, 2, 3, 4, 5, 6].map(offer));
      expect(signals.certifiedAsked).toBe(0);
    });

    it('falls back to the Market best sellers when the views cannot be read', async () => {
      signals.views = null;

      expect(offersOf(await forYou())).toEqual([1, 2, 3, 4, 5, 6].map(offer));
    });

    it('answers the same list as the public best sellers for a shopper with nothing recorded', async () => {
      const plain = await forYou();
      const guestPlain = await forYouGuest();

      expect(guestPlain).toEqual(plain);
      expect(plain.ok && plain.value.items[0]).toEqual({
        ...itemOf(hit(1, [GROCERY])),
        primaryImage: null,
      });
    });

    it('shows each Offer once', async () => {
      signals.views = { productIds: [product(2)], categoryIds: [MEAT, GROCERY] };
      sources.ranked = [2, 2, 1, 4, 1].map(offer);

      const items = offersOf(await forYou({ limit: 24 }));

      expect(items).toEqual([...new Set(items)]);
      expect(items?.length).toBe(6);
    });

    it('stops at the limit (default 12) and refuses a limit outside 1 to 24', async () => {
      signals.views = { productIds: [], categoryIds: [MEAT] };
      expect(offersOf(await forYou({ limit: 2 }))).toEqual([2, 4].map(offer));
      expect(offersOf(await forYou({ limit: 1 }))).toEqual([offer(2)]);
      shelves.documents = [...Array(20).keys()].map((n) => hit(100 + n, [GROCERY]));
      sources.ranked = [];
      expect(offersOf(await forYou())).toHaveLength(12);
      expect(offersOf(await forYou({ limit: 24 }))).toHaveLength(20);

      for (const limit of [0, 25, 1.5, -1]) {
        expect(await forYou({ limit })).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
        });
      }
    });

    it('drops an Offer that catalog or sellers no longer show, and re-checks all candidates', async () => {
      signals.views = { productIds: [], categoryIds: [MEAT] };
      visibility.hidden = new Set([offer(2), offer(1)]);

      expect(offersOf(await forYou())).toEqual([4, 5, 3, 6].map(offer));
      expect(visibility.checked).toContain(offer(2));
    });

    it('answers search.unavailable when the check or the ordering source fails', async () => {
      visibility.failing = true;
      expect(await forYou()).toEqual({ ok: false, error: { code: 'search.unavailable' } });
      visibility.failing = false;
      sources.ranked = null;
      expect(await forYou()).toEqual({ ok: false, error: { code: 'search.unavailable' } });
    });

    it('passes the privacy signals and the caller to engagement unchanged', async () => {
      const privacy = { globalPrivacyControl: true, consent: false, guestToken: 'tok' };

      await forYou({ privacy });
      await forYouGuest({ privacy });

      expect(signals.viewsAsked).toEqual([
        { actor: 'authenticated', privacy },
        { actor: 'anonymous', privacy },
      ]);
    });

    it('refuses a guest on the customer path and a customer sees the guest path as a guest', async () => {
      expect(await forYou({}, guest)).toMatchObject({ ok: false });
      const asGuest = await new ListForYouGuest(gate, deps).execute(customer, { privacy: QUIET });
      expect(asGuest.ok).toBe(true);
      expect(signals.viewsAsked.at(-1)?.actor).toBe('anonymous');
    });
  });

  describe('recently viewed', () => {
    beforeEach(() => {
      shelves.documents = [1, 2, 3, 4].map((n) => hit(n, [GROCERY]));
      signals.views = { productIds: [product(3), product(1), product(4)], categoryIds: [] };
    });

    it('gives each item its first public photo, and none when the photo source fails', async () => {
      const PHOTO = id<'ProductImage'>(0x701);
      images.images_.set(product(3), [{ imageId: PHOTO, width: 640, height: 480 }]);

      const withPhoto = await recent();
      const forYouPhoto = await forYou();
      images.failing = true;
      const without = await recent();

      expect(withPhoto.ok && withPhoto.value.items.map((i) => i.primaryImage)).toEqual([
        { imageId: PHOTO, width: 640, height: 480, alt: hit(3, []).name },
        null,
        null,
      ]);
      expect(
        forYouPhoto.ok && forYouPhoto.value.items.find((i) => i.productId === product(3)),
      ).toMatchObject({ primaryImage: { imageId: PHOTO } });
      expect(without.ok && without.value.items.map((i) => i.primaryImage)).toEqual([
        null,
        null,
        null,
      ]);
    });

    it('lists the viewed products in viewed order', async () => {
      expect(offersOf(await recent())).toEqual([3, 1, 4].map(offer));
      expect(offersOf(await recentGuest())).toEqual([3, 1, 4].map(offer));
    });

    it('drops a product that is not sellable now and keeps the order', async () => {
      visibility.hidden = new Set([offer(1)]);

      expect(offersOf(await recent())).toEqual([3, 4].map(offer));
    });

    it('shows a product through its first Offer that is sellable now', async () => {
      shelves.documents.push(hit(9, [GROCERY], 3));
      visibility.hidden = new Set([offer(3)]);

      expect(offersOf(await recent())).toEqual([9, 1, 4].map(offer));
    });

    it('keeps the newest viewed product when an older one has more Offers than any cap', async () => {
      // Product 5000 sorts after product 3, and product 3 has far more Offers than the old
      // whole-answer cap of 500: the newest view (5000) must still be shown.
      shelves.documents = [
        ...[...Array(600).keys()].map((n) => hit(2000 + n, [GROCERY], 3)),
        hit(1, [GROCERY], 5000),
      ];
      signals.views = { productIds: [product(5000), product(3)], categoryIds: [] };

      const items = offersOf(await recent());

      expect(items).toEqual([offer(1), offer(2000)]);
    });

    it('drops a viewed product that has no indexed Offer', async () => {
      signals.views = { productIds: [product(77), product(2)], categoryIds: [] };

      expect(offersOf(await recent())).toEqual([offer(2)]);
    });

    it('stops at the limit and refuses a limit outside 1 to 24', async () => {
      expect(offersOf(await recent({ limit: 2 }))).toEqual([3, 1].map(offer));
      expect(await recent({ limit: 0 })).toMatchObject({ ok: false });
      expect(await recent({ limit: 25 })).toMatchObject({ ok: false });
    });

    it('is empty without views and then checks nothing', async () => {
      signals.views = { productIds: [], categoryIds: [category(1)] };

      expect(await recent()).toEqual({ ok: true, value: { items: [] } });
      expect(visibility.checked).toEqual([]);
    });

    it('does not filter by certification: the shopper viewed these products themselves', async () => {
      shelves.documents = [hit(4, [MEAT, HALAL])];
      signals.views = { productIds: [product(4)], categoryIds: [HALAL] };
      signals.certified = new Set([HALAL]);

      expect(offersOf(await recent())).toEqual([offer(4)]);
      expect(signals.certifiedAsked).toBe(0);
    });

    it('answers search.unavailable when the views or the check fail', async () => {
      signals.views = null;
      expect(await recent()).toEqual({ ok: false, error: { code: 'search.unavailable' } });
      signals.views = { productIds: [product(1)], categoryIds: [] };
      visibility.failing = true;
      expect(await recent()).toEqual({ ok: false, error: { code: 'search.unavailable' } });
    });

    it('passes the privacy signals and the caller to engagement unchanged', async () => {
      const privacy = { globalPrivacyControl: false, consent: true, guestToken: 'tok' };

      await recent({ privacy });
      await recentGuest({ privacy });

      expect(signals.viewsAsked).toEqual([
        { actor: 'authenticated', privacy },
        { actor: 'anonymous', privacy },
      ]);
    });
  });
});
