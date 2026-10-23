import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Money } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { OfferHit } from '../domain/offer-document';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import type { ProductDetailDependencies } from './product-detail-dependencies';
import {
  detailKeyOf,
  type DetailBadge,
  type DetailKey,
  type DetailPrice,
  type DetailProduct,
  type DetailSeller,
  type DetailStock,
  type ProductDetailSources,
} from './ports/product-detail-sources';
import type { ProductImages, PublicImage } from './ports/product-images';
import type { PublicVisibility } from './ports/public-visibility';
import type { PublishedVariants } from './ports/published-variants';
import type { ShelfDocumentsReader } from './ports/shelf-documents.reader';
import {
  MAX_DETAIL_KEYS,
  BADGES_DEADLINE_MS,
  MAX_DETAIL_OFFERS,
  ViewProductDetail,
} from './use-cases/view-product-detail.use-case';

// The product page read in memory on both Market fixtures (AU in AUD, ZZ in JPY): the Offers come
// from the read model, catalog and sellers re-check them, each source is asked with the request's
// context, and a unit appears only with a price in the Market currency. Prices come lowest first;
// stock is a status and "only left", never the exact count. A source or check that fails is
// `search.unavailable`.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const ENDS = Temporal.Instant.from('2026-10-20T00:00:00Z');

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const PRODUCT = id<'Product'>(0x900);
const offer = (n: number): Id<'Offer'> => id<'Offer'>(0x1000 + n);
const variant = (n: number): Id<'Variant'> => id<'Variant'>(0x2000 + n);
const seller = (n: number): Id<'Seller'> => id<'Seller'>(0x5000 + n);
const CATEGORY = id<'Category'>(0xca);

const hit = (n: number, productId = PRODUCT, sellerNo = n): OfferHit => ({
  offerId: offer(n),
  productId,
  sellerId: seller(sellerNo),
  name: `Product ${n}`,
  shortText: null,
  categoryIds: [CATEGORY],
  rank: 0,
});

class MemoryShelves implements ShelfDocumentsReader {
  documents: OfferHit[] = [];
  readonly asked: { productId: Id<'Product'>; limit: number }[] = [];
  byOfferIds() {
    return Promise.resolve([]);
  }
  byProductId(_market: MarketContext, productId: Id<'Product'>, limit: number) {
    this.asked.push({ productId, limit });
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
  byProductIds() {
    return Promise.resolve([]);
  }
  browseAll() {
    return Promise.resolve([]);
  }
}

class StubImages implements ProductImages {
  images_ = new Map<Id<'Product'>, PublicImage[]>();
  failing = false;
  readonly asked: Id<'Product'>[][] = [];
  of(_context: CallContext, productIds: readonly Id<'Product'>[]) {
    this.asked.push([...productIds]);
    return Promise.resolve(this.failing ? null : new Map(this.images_));
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

class StubVariants implements PublishedVariants {
  /** Per Offer, the sell units it has; an Offer not listed has all of `all`. */
  units = new Map<Id<'Offer'>, Id<'Variant'>[]>();
  all = [variant(1), variant(2)];
  failing = false;
  published(_context: CallContext, offerIds: readonly Id<'Offer'>[]) {
    if (this.failing) return Promise.resolve(null);
    return Promise.resolve(
      new Map(offerIds.map((o) => [o, new Set(this.units.get(o) ?? this.all)])),
    );
  }
}

class StubSources implements ProductDetailSources {
  product_: { product: DetailProduct | null } | null = null;
  priced = new Map<string, DetailPrice>();
  stock = new Map<string, DetailStock>();
  sellers_: Map<Id<'Seller'>, DetailSeller> | null = new Map();
  badges_ = new Map<Id<'Offer'>, readonly DetailBadge[]>();
  badgesFailing: 'null' | 'throw' | 'hang' | null = null;
  readonly badgesAsked: Id<'Offer'>[][] = [];
  pricesFailing = false;
  stockFailing = false;
  readonly asked: { kind: string; actor: string; locale?: string; keys?: number }[] = [];
  product(context: CallContext, _productId: Id<'Product'>, locale: string) {
    this.asked.push({ kind: 'product', actor: context.actor.kind, locale });
    return Promise.resolve(this.product_);
  }
  prices(context: CallContext, keys: readonly DetailKey[]) {
    this.asked.push({ kind: 'prices', actor: context.actor.kind, keys: keys.length });
    return Promise.resolve(this.pricesFailing ? null : this.priced);
  }
  availability(context: CallContext, keys: readonly DetailKey[]) {
    this.asked.push({ kind: 'availability', actor: context.actor.kind, keys: keys.length });
    return Promise.resolve(this.stockFailing ? null : this.stock);
  }
  badges(context: CallContext, offerIds: readonly Id<'Offer'>[]) {
    this.asked.push({ kind: 'badges', actor: context.actor.kind });
    this.badgesAsked.push([...offerIds]);
    if (this.badgesFailing === 'throw') return Promise.reject(new Error('badges down'));
    if (this.badgesFailing === 'hang') return new Promise<never>(() => undefined);
    return Promise.resolve(this.badgesFailing === 'null' ? null : this.badges_);
  }
  sellers(context: CallContext) {
    this.asked.push({ kind: 'sellers', actor: context.actor.kind });
    return Promise.resolve(this.sellers_);
  }
}

describe.each([
  ['AU', 'en-AU', 'AUD'],
  ['ZZ', 'ja-JP', 'JPY'],
] as const)('product page read in market %s', (code, locale, currency) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const anonymous = testCallContext(market, 'anonymous', 'detail-anon-abcdef');
  const system = testCallContext(market, 'system', 'detail-system-abcd');
  const money = (amount: bigint, inCurrency = currency): Money => ({
    amount,
    currency: inCurrency,
  });

  let shelves: MemoryShelves;
  let sources: StubSources;
  let visibility: StubVisibility;
  let variants: StubVariants;
  let images: StubImages;
  let deps: ProductDetailDependencies;

  const content = (): DetailProduct => ({
    name: 'Dates',
    shortDescription: 'Sweet',
    description: null,
    categoryIds: [CATEGORY],
    variants: [
      { variantId: variant(1), label: '500 g' },
      { variantId: variant(2), label: null },
    ],
  });
  const price = (offerNo: number, variantNo: number, amount: bigint, extra = {}): void => {
    sources.priced.set(detailKeyOf({ offerId: offer(offerNo), variantId: variant(variantNo) }), {
      price: money(amount),
      taxInclusive: true,
      special: null,
      ...extra,
    });
  };
  const run = (input: object = { productId: PRODUCT }, context = anonymous) =>
    new ViewProductDetail(gate, deps).execute(context, input as { productId: string });

  beforeEach(() => {
    shelves = new MemoryShelves();
    sources = new StubSources();
    visibility = new StubVisibility();
    variants = new StubVariants();
    images = new StubImages();
    sources.product_ = { product: content() };
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      shelves,
      sources,
      visibility,
      policy: new ConfigSearchPolicy(markets),
      variants,
      images,
    };
  });

  it('shows the content and the priced Offers, cheapest first, ties by Offer id', async () => {
    shelves.documents = [hit(3), hit(1), hit(2)];
    price(1, 1, 900n);
    price(1, 2, 1200n);
    price(2, 1, 700n);
    price(3, 2, 700n);

    const result = await run();

    expect(result.ok && result.value.name).toBe('Dates');
    expect(result.ok && result.value.categoryIds).toEqual([CATEGORY]);
    expect(result.ok && result.value.offers.map((o) => o.offerId)).toEqual([
      offer(2),
      offer(3),
      offer(1),
    ]);
    expect(result.ok && result.value.offers[2]?.units).toEqual([
      expect.objectContaining({ variantId: variant(1), label: '500 g', price: money(900n) }),
      expect.objectContaining({ variantId: variant(2), label: null, price: money(1200n) }),
    ]);
    expect(shelves.asked).toEqual([{ productId: PRODUCT, limit: MAX_DETAIL_OFFERS }]);
  });

  describe('photos', () => {
    const PHOTOS = [0x701, 0x702, 0x703].map((n) => id<'ProductImage'>(n));

    it('lists the public photos in the published order, each with the product name as alt', async () => {
      shelves.documents = [hit(1)];
      price(1, 1, 900n);
      images.images_.set(
        PRODUCT,
        PHOTOS.map((imageId, index) => ({ imageId, width: 1600 - index, height: 1200 })),
      );

      const result = await run();

      expect(result.ok && result.value.images).toEqual(
        PHOTOS.map((imageId, index) => ({
          imageId,
          width: 1600 - index,
          height: 1200,
          alt: 'Dates',
        })),
      );
      expect(images.asked).toEqual([[PRODUCT]]);
    });

    it('has no photo for a product with none, and never more than 8', async () => {
      shelves.documents = [hit(1)];
      price(1, 1, 900n);
      expect((await run()).ok && (await run())).toMatchObject({ value: { images: [] } });

      images.images_.set(
        PRODUCT,
        [...Array(12).keys()].map((n) => ({
          imageId: id<'ProductImage'>(0x800 + n),
          width: 100,
          height: 100,
        })),
      );
      const result = await run();
      expect(result.ok && result.value.images).toHaveLength(8);
    });

    it('still shows the product, without photos, when the photo source cannot answer', async () => {
      shelves.documents = [hit(1)];
      price(1, 1, 900n);
      images.failing = true;

      const result = await run();

      expect(result.ok && result.value.images).toEqual([]);
      expect(result.ok && result.value.offers).toHaveLength(1);
    });

    it('reads no photo for a product that is not found', async () => {
      shelves.documents = [];

      await run();

      expect(images.asked).toEqual([]);
    });
  });

  it('asks catalog for the Market default locale and every source as the request actor', async () => {
    shelves.documents = [hit(1)];
    price(1, 1, 900n);

    await run();

    const asked = sources.asked.map((a) => [a.kind, a.actor, a.locale ?? null]);
    expect(asked).toContainEqual(['product', 'anonymous', locale]);
    expect(asked.map(([kind]) => kind).sort()).toEqual([
      'availability',
      'badges',
      'prices',
      'product',
      'sellers',
    ]);
    expect(asked.every(([, actor]) => actor === 'anonymous')).toBe(true);
  });

  describe('certification badges', () => {
    const halal: DetailBadge = {
      typeCode: 'halal',
      typeName: 'Halal',
      basis: 'SELLER',
      sellerClaim: false,
      issuerName: 'Council',
      validUntilLocalDate: '2027-01-31',
      verifiedWithIssuer: true,
    };

    it('puts each Offer its own badges, none for an Offer without, in one ask for the page', async () => {
      shelves.documents = [hit(1), hit(2)];
      price(1, 1, 900n);
      price(2, 1, 800n);
      sources.badges_ = new Map([[offer(1), [halal]]]);

      const result = await run();

      expect(result.ok && result.value.offers.map((o) => [o.offerId, o.badges])).toEqual([
        [offer(2), []],
        [offer(1), [halal]],
      ]);
      expect(sources.badgesAsked).toEqual([[offer(1), offer(2)]]);
    });

    it.each(['null', 'throw'] as const)(
      'still answers the page, with no badge on any Offer, when the badge source gives %s',
      async (failing) => {
        shelves.documents = [hit(1), hit(2)];
        price(1, 1, 900n);
        price(2, 1, 800n);
        sources.badges_ = new Map([[offer(1), [halal]]]);
        sources.badgesFailing = failing;

        const result = await run();

        expect(result.ok && result.value.offers.map((o) => o.badges)).toEqual([[], []]);
      },
    );

    it('answers the page with no badge when the badge source is slower than the deadline', async () => {
      jest.useFakeTimers();
      try {
        shelves.documents = [hit(1), hit(2)];
        price(1, 1, 900n);
        price(2, 1, 800n);
        sources.badges_ = new Map([[offer(1), [halal]]]);
        sources.badgesFailing = 'hang';

        const pending = run();
        await jest.advanceTimersByTimeAsync(BADGES_DEADLINE_MS);
        const result = await pending;

        expect(result.ok && result.value.offers.map((o) => o.badges)).toEqual([[], []]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('asks no badge for an Offer that is dropped for having no priced unit', async () => {
      shelves.documents = [hit(1), hit(2)];
      price(1, 1, 900n);
      sources.badges_ = new Map([[offer(1), [halal]]]);

      const result = await run();

      expect(result.ok && result.value.offers.map((o) => o.offerId)).toEqual([offer(1)]);
    });
  });

  it('passes the stock status and only-left through, an unanswered key being out, and never the count', async () => {
    shelves.documents = [hit(1)];
    price(1, 1, 900n);
    price(1, 2, 950n);
    sources.stock.set(detailKeyOf({ offerId: offer(1), variantId: variant(1) }), {
      status: 'low',
      onlyLeft: 3,
    });
    const result = await run();

    expect(result.ok && result.value.offers[0]?.units.map((u) => u.stock)).toEqual([
      { status: 'low', onlyLeft: 3 },
      { status: 'out', onlyLeft: null },
    ]);
    expect(
      JSON.stringify(result, (_, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
    ).not.toContain('sellable');
  });

  it('carries the special with its end, the tax flag, the store name and the minimum order', async () => {
    shelves.documents = [hit(1), hit(2)];
    price(1, 1, 800n, { special: { endsAt: ENDS }, taxInclusive: false });
    price(2, 1, 900n);
    sources.sellers_ = new Map([
      [seller(1), { storeName: 'Date Co', minimumOrder: money(2500n) }],
      [seller(2), { storeName: null }],
    ]);

    const result = await run();

    expect(result.ok && result.value.offers[0]).toMatchObject({
      offerId: offer(1),
      sellerId: seller(1),
      seller: { storeName: 'Date Co', minimumOrder: money(2500n) },
      units: [{ special: { endsAt: ENDS }, taxInclusive: false }],
    });
    const second = result.ok ? result.value.offers[1] : undefined;
    expect(second?.seller).toEqual({ storeName: null });
    expect(second?.seller).not.toHaveProperty('minimumOrder');
  });

  it('keeps a null minimum order (no minimum) apart from an absent one', async () => {
    shelves.documents = [hit(1)];
    price(1, 1, 900n);
    sources.sellers_ = new Map([[seller(1), { storeName: 'Date Co', minimumOrder: null }]]);

    const result = await run();

    expect(result.ok && result.value.offers[0]?.seller).toEqual({
      storeName: 'Date Co',
      minimumOrder: null,
    });
  });

  it('drops an unpriced unit, a unit priced in another currency and an Offer left with none', async () => {
    shelves.documents = [hit(1), hit(2), hit(3)];
    price(1, 1, 900n);
    sources.priced.set(detailKeyOf({ offerId: offer(1), variantId: variant(2) }), {
      price: money(100n, currency === 'AUD' ? 'JPY' : 'AUD'),
      taxInclusive: true,
      special: null,
    });
    price(2, 1, 500n);
    variants.units.set(offer(2), [variant(1), variant(2)]);
    // Offer 3 has no price at all.

    const result = await run();

    expect(result.ok && result.value.offers.map((o) => [o.offerId, o.units.length])).toEqual([
      [offer(2), 1],
      [offer(1), 1],
    ]);
  });

  it('prices only the Variants that are published sell units of the Offer and of the content', async () => {
    shelves.documents = [hit(1)];
    variants.all = [variant(1), variant(2), variant(9)];
    variants.units.set(offer(1), [variant(2), variant(9)]);
    price(1, 1, 100n);
    price(1, 2, 200n);
    price(1, 9, 300n);

    const result = await run();

    expect(result.ok && result.value.offers[0]?.units.map((u) => u.variantId)).toEqual([
      variant(2),
    ]);
  });

  it('keeps the keys within the pricing batch by leaving the last Offers (by id) out', async () => {
    const many = Array.from({ length: 15 }, (_, i) => variant(i + 1));
    sources.product_ = {
      product: { ...content(), variants: many.map((variantId) => ({ variantId, label: null })) },
    };
    variants.all = many;
    shelves.documents = Array.from({ length: MAX_DETAIL_OFFERS }, (_, i) => hit(i + 1));
    for (let o = 1; o <= MAX_DETAIL_OFFERS; o++) price(o, 1, BigInt(o));

    const result = await run();

    const keys = Math.floor(MAX_DETAIL_KEYS / many.length) * many.length;
    expect(sources.asked.find((a) => a.kind === 'prices')?.keys).toBe(keys);
    expect(result.ok && result.value.offers).toHaveLength(
      Math.floor(MAX_DETAIL_KEYS / many.length),
    );
  });

  it('is not found for an invalid id without reading anything', async () => {
    const result = await run({ productId: 'not-a-uuid' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'productId', code: 'format' }] },
    });
    expect(shelves.asked).toEqual([]);
    expect(sources.asked).toEqual([]);
  });

  it('is not found when no Offer is indexed, or none is visible, without asking any source', async () => {
    expect(await run()).toEqual({ ok: false, error: { code: 'search.product-not-found' } });

    shelves.documents = [hit(1), hit(2)];
    visibility.hidden = new Set([offer(1), offer(2)]);
    expect(await run()).toEqual({ ok: false, error: { code: 'search.product-not-found' } });
    expect(sources.asked).toEqual([]);
  });

  it('is not found when catalog has no published product, or no Offer has a priced unit', async () => {
    shelves.documents = [hit(1)];
    price(1, 1, 900n);
    sources.product_ = { product: null };
    expect(await run()).toEqual({ ok: false, error: { code: 'search.product-not-found' } });

    sources.product_ = { product: content() };
    sources.priced.clear();
    expect(await run()).toEqual({ ok: false, error: { code: 'search.product-not-found' } });
  });

  it('leaves out an Offer that catalog or sellers no longer show', async () => {
    shelves.documents = [hit(1), hit(2)];
    price(1, 1, 100n);
    price(2, 1, 200n);
    visibility.hidden.add(offer(1));

    const result = await run();

    expect(result.ok && result.value.offers.map((o) => o.offerId)).toEqual([offer(2)]);
  });

  describe('is unavailable, never an unchecked page, when', () => {
    beforeEach(() => {
      shelves.documents = [hit(1)];
      price(1, 1, 900n);
    });
    const unavailable = { ok: false, error: { code: 'search.unavailable' } };

    it('the visibility check fails', async () => {
      visibility.failing = true;
      expect(await run()).toEqual(unavailable);
    });
    it('catalog fails', async () => {
      sources.product_ = null;
      expect(await run()).toEqual(unavailable);
    });
    it('the published sell units cannot be read', async () => {
      variants.failing = true;
      expect(await run()).toEqual(unavailable);
    });
    it('pricing fails', async () => {
      sources.pricesFailing = true;
      expect(await run()).toEqual(unavailable);
    });
    it('inventory fails', async () => {
      sources.stockFailing = true;
      expect(await run()).toEqual(unavailable);
    });
    it('sellers fails', async () => {
      sources.sellers_ = null;
      expect(await run()).toEqual(unavailable);
    });
  });

  it('is not for the system actor (rule anonymous)', async () => {
    shelves.documents = [hit(1)];

    const result = await run({ productId: PRODUCT }, system);

    expect(result.ok).toBe(false);
    expect(shelves.asked).toEqual([]);
  });
});
