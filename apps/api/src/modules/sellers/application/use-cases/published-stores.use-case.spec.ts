import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ApprovedStoreFacts } from '../../domain/published-store';
import type { AccessState } from '../../domain/seller-status';
import { MarketConfigMinimumOrderPolicy } from '../../infrastructure/market-config-minimum-order-policy';
import type { PublishedStoreRepository } from '../ports/published-store.repository';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type {
  ApprovedSellingFacts,
  SellingFactsRepository,
} from '../ports/selling-facts.repository';
import type { StoreProfileRepository } from '../ports/store-profile.repository';
import { PublishedAboutCache } from '../store-profile/published-about-cache';
import { PublishedStoreContentReader } from '../store-profile/published-store-content';
import { MarketConfigStoreProfileLocales } from '../../infrastructure/market-config-store-profile-locales';
import {
  FakeContentSealer,
  InMemoryStoreContent,
  InMemoryStoreImages,
  MapObjectStore,
} from '../testing/in-memory-store-profile';
import { contentOf } from '../../domain/store-profile-content';
import { PublishedStoreImageRead } from './published-store-image-read.use-case';
import { PublishedStoreList } from './published-store-list.use-case';
import { PublishedStoreRead } from './published-store-read.use-case';
import { PublishedStoreSellerId } from './published-store-seller-id.use-case';
import { PublishedStoreSlugs } from './published-store-slugs.use-case';

// The public store reads (slice 12) with in-memory ports, on both Market fixtures (AU in AUD, ZZ
// in JPY): only stores that may sell now, allow-listed fields only, sorts and pages, the minimum
// order and its currency check, and the fail-closed answers. The PostgreSQL reads are covered by
// test/db/sellers-public-stores.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const minimumOrderPolicy = new MarketConfigMinimumOrderPolicy(markets);
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-10-10T10:00:00Z')));

const unitOfWork: UnitOfWork = {
  run<T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) {
    return work();
  },
  runOnce: () => Promise.reject(new Error('not used')),
};

describe.each([
  ['AU', 'AUD', 'Australia/Brisbane'],
  ['ZZ', 'JPY', 'Pacific/Auckland'],
] as const)('public store reads, Market %s', (code, currency, zone) => {
  const market = () => testMarketContext(code, 'default');
  const anonymous = (): CallContext => testCallContext(market(), 'anonymous');
  let stores: ApprovedStoreFacts[];
  let facts: Map<string, ApprovedSellingFacts>;
  let states: Map<string, AccessState>;
  let minimums: Map<string, Money | null>;
  let failStores: boolean;
  let identityCalls: number;
  let identityDown: boolean;
  let clock: FixedClock;
  let list: PublishedStoreList;
  let read: PublishedStoreRead;
  let sellerIdRead: PublishedStoreSellerId;
  let imageRead: PublishedStoreImageRead;
  let storeContent: InMemoryStoreContent;
  let storeImages: InMemoryStoreImages;
  let objectStore: MapObjectStore;
  let slugs: PublishedStoreSlugs;

  const addStore = (
    slug: string,
    name: string,
    firstApprovedAt: string,
    options: { state?: AccessState; minimum?: Money | null } = {},
  ): Id<'Seller'> => {
    const sellerId = ids.next<'Seller'>();
    stores.push({
      sellerId,
      slug,
      name,
      serviceAreaCode: 'area-1',
      operatingTimezone: zone,
      firstApprovedAt: Temporal.Instant.from(firstApprovedAt),
    });
    facts.set(sellerId, { hasIdentifier: true, operatingTimezone: zone, openClaimConflict: false });
    states.set(sellerId, options.state ?? 'approved');
    if (options.minimum !== undefined) minimums.set(sellerId, options.minimum);
    return sellerId;
  };

  beforeEach(() => {
    stores = [];
    facts = new Map();
    states = new Map();
    minimums = new Map();
    failStores = false;
    identityCalls = 0;
    identityDown = false;
    clock = new FixedClock(Temporal.Instant.from('2026-10-20T00:00:00Z'));
    const publishedStores: PublishedStoreRepository = {
      approvedStores: (_market, limit) =>
        failStores ? Promise.reject(new Error('down')) : Promise.resolve(stores.slice(0, limit)),
      approvedStoreBySlug: (_market, slug) =>
        failStores
          ? Promise.reject(new Error('down'))
          : Promise.resolve(stores.find((store) => store.slug === slug) ?? null),
    };
    const sellingFacts: SellingFactsRepository = {
      approvedSellingFacts: (_market, sellerIds) =>
        Promise.resolve(
          new Map(
            sellerIds.flatMap((id) => {
              const found = facts.get(id);
              return found === undefined ? [] : [[id, found] as const];
            }),
          ),
        ),
      allowedProductTypes: () => Promise.reject(new Error('not used')),
      blogEnabled: () => Promise.reject(new Error('not used')),
    };
    const accessReader = {
      accessOfMany: (_context: CallContext, sellerIds: readonly Id<'Seller'>[]) => {
        identityCalls += 1;
        if (identityDown) return Promise.reject(new Error('identity down'));
        return Promise.resolve(
          new Map(
            sellerIds.flatMap((id) => {
              const state = states.get(id);
              return state === undefined ? [] : [[id, state] as const];
            }),
          ),
        );
      },
    } as unknown as SellerAccessReader;
    const storeProfiles = {
      approvedMinimumOrders: (_market: MarketContext, sellerIds: readonly Id<'Seller'>[]) =>
        Promise.resolve(
          new Map(
            sellerIds.flatMap((id) =>
              minimums.has(id) ? [[id, minimums.get(id) ?? null] as const] : [],
            ),
          ),
        ),
    } as unknown as StoreProfileRepository;
    const policy = {
      businessIdentifier: () => ({ scheme: 'x', required: true, labelKey: 'x' }),
    } as unknown as SellerMarketPolicy;
    storeContent = new InMemoryStoreContent();
    storeImages = new InMemoryStoreImages();
    objectStore = new MapObjectStore();
    const publishedContent = new PublishedStoreContentReader({
      unitOfWork,
      storeContent,
      storeImages,
      contentSealer: new FakeContentSealer(),
      localesPolicy: new MarketConfigStoreProfileLocales(markets),
      aboutCache: new PublishedAboutCache(clock),
    });
    const deps = {
      unitOfWork,
      sellingFacts,
      accessReader,
      policy,
      publishedStores,
      storeProfiles,
      minimumOrderPolicy,
      publishedContent,
      clock,
    };
    list = new PublishedStoreList(gate, deps);
    read = new PublishedStoreRead(gate, deps);
    sellerIdRead = new PublishedStoreSellerId(gate, deps);
    imageRead = new PublishedStoreImageRead(gate, { ...deps, objectStore });
    slugs = new PublishedStoreSlugs(gate, deps);
  });

  const page = async (input: Parameters<PublishedStoreList['execute']>[1] = {}) => {
    const result = await list.execute(anonymous(), input);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };

  it('lists only stores that may sell now, by name, with the allow-listed fields', async () => {
    addStore('zeta-foods', 'Zeta Foods', '2025-03-01T00:00:00Z', { minimum: null });
    addStore('alpha-market', 'alpha market', '2026-01-10T00:00:00Z', {
      minimum: { amount: 3000n, currency },
    });
    addStore('gone-store', 'Gone Store', '2026-01-10T00:00:00Z', { state: 'suspended' });

    const answer = await page();

    expect(answer).toEqual({
      items: [
        {
          slug: 'alpha-market',
          name: 'alpha market',
          serviceAreaCode: 'area-1',
          sellingSince: 2026,
          minimumOrder: { amount: 3000n, currency },
          logo: null,
        },
        {
          slug: 'zeta-foods',
          name: 'Zeta Foods',
          serviceAreaCode: 'area-1',
          sellingSince: 2025,
          minimumOrder: null,
          logo: null,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 24,
    });
  });

  it('sorts newest first and pages with a stable order', async () => {
    addStore('b-store', 'B', '2026-05-01T00:00:00Z');
    addStore('a-store', 'A', '2026-05-01T00:00:00Z');
    addStore('c-store', 'C', '2026-06-01T00:00:00Z');

    const first = await page({ sort: 'newest', pageSize: 2 });
    const second = await page({ sort: 'newest', pageSize: 2, page: 2 });

    expect(first.items.map((item) => item.slug)).toEqual(['c-store', 'a-store']);
    expect(second.items.map((item) => item.slug)).toEqual(['b-store']);
    expect(second.total).toBe(3);
  });

  it("reads the selling-since year in the seller's own zone", async () => {
    // 31 Dec 2025 23:30 UTC is already 2026 in Brisbane and Auckland.
    addStore('new-year', 'New Year', '2025-12-31T23:30:00Z');

    expect((await page()).items[0]?.sellingSince).toBe(2026);
  });

  it("leaves the minimum out when its currency is not the Market's", async () => {
    addStore('odd-store', 'Odd', '2026-01-01T00:00:00Z', {
      minimum: { amount: 100n, currency: currency === 'AUD' ? 'JPY' : 'AUD' },
    });

    const [item] = (await page()).items;

    expect(item).toBeDefined();
    expect(item && 'minimumOrder' in item).toBe(false);
  });

  it('asks identity once per 100 stores', async () => {
    for (let n = 0; n < 150; n += 1) {
      addStore(`store-${n.toString().padStart(3, '0')}`, `Store ${n}`, '2026-01-01T00:00:00Z');
    }

    const answer = await page({ pageSize: 48 });

    expect(answer.total).toBe(150);
    expect(identityCalls).toBe(2);
  });

  it('refuses a bad sort, page or page size whole', async () => {
    const result = await list.execute(anonymous(), { sort: 'price', page: 0, pageSize: 49 });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'sort', code: 'one-of' },
          { path: 'page', code: 'range' },
          { path: 'pageSize', code: 'range' },
        ],
      },
    });
  });

  it('answers sellers.unavailable when the read fails, never a partial list', async () => {
    addStore('a-store', 'A', '2026-01-01T00:00:00Z');
    failStores = true;

    expect(await list.execute(anonymous(), {})).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
  });

  it("reuses the Market's set of selling stores for 30 seconds, then asks again", async () => {
    addStore('a-store', 'A', '2026-01-01T00:00:00Z');
    await page();
    addStore('b-store', 'B', '2026-01-01T00:00:00Z');

    expect((await page()).total).toBe(1);
    expect(identityCalls).toBe(1);

    clock.advance(Temporal.Duration.from({ seconds: 30 }));

    expect((await page()).total).toBe(2);
    expect(identityCalls).toBe(2);
  });

  it('shows no store while identity is down: the may-sell contract answers no (fail closed)', async () => {
    addStore('a-store', 'A', '2026-01-01T00:00:00Z');
    identityDown = true;

    expect((await page()).total).toBe(0);
    expect(await read.execute(anonymous(), { slug: 'a-store' })).toEqual({
      ok: false,
      error: { code: 'sellers.store-not-found' },
    });
  });

  it('reads one store by its exact slug', async () => {
    addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z', { minimum: null });

    expect(await read.execute(anonymous(), { slug: 'alpha-market' })).toEqual(
      ok({
        slug: 'alpha-market',
        name: 'Alpha',
        serviceAreaCode: 'area-1',
        sellingSince: 2026,
        minimumOrder: null,
        about: null,
        logo: null,
        banner: null,
      }),
    );
  });

  it.each([
    ['a store that may not sell', 'held-back', 'held-back'],
    ['an unknown slug', 'held-back', 'no-such-store'],
    ['a slug in another case', 'held-back', 'Held-Back'],
    ['a malformed slug', 'held-back', '../x'],
  ])('answers not found alike for %s', async (_name, stored, asked) => {
    addStore(stored, 'Held', '2026-01-10T00:00:00Z', {
      state: asked === stored ? 'suspended' : 'approved',
    });

    expect(await read.execute(anonymous(), { slug: asked })).toEqual({
      ok: false,
      error: { code: 'sellers.store-not-found' },
    });
  });

  const defaultLocale = code === 'AU' ? 'en-AU' : 'ja-JP';

  const setAbout = async (sellerId: Id<'Seller'>, text: string): Promise<void> => {
    storeContent.addProfile(market(), sellerId);
    const sealed = await new FakeContentSealer().seal(
      market(),
      sellerId,
      contentOf({ [defaultLocale]: text }),
    );
    if (!sealed.ok) throw new Error('fixture failed');
    await storeContent.publish(market(), sellerId, {
      id: ids.next<'StoreProfileRevision'>(),
      expectedRevisionNo: 0,
      ciphertext: sealed.value.ciphertext,
      schemaVersion: 1,
      contentHash: sealed.value.contentHash,
      authorAccountId: ids.next<'Account'>(),
      createdAt: Temporal.Instant.from('2026-10-20T00:00:00Z'),
    });
  };

  const setImage = async (
    sellerId: Id<'Seller'>,
    kind: 'logo' | 'banner',
  ): Promise<{ id: Id<'StoreImage'>; keys: string[] }> => {
    const id = ids.next<'StoreImage'>();
    const renditions = (['large', 'small'] as const).map((size) => ({
      size,
      objectKey: `${sellerId}/store-images/${id}/${size}`,
      sha256: Buffer.alloc(32),
      byteSize: 3,
      width: size === 'large' ? 512 : 128,
      height: size === 'large' ? 512 : 128,
    }));
    for (const rendition of renditions) {
      await objectStore.put(rendition.objectKey, Buffer.from(`${id}:${rendition.size}`));
    }
    await storeImages.replace(market(), sellerId, {
      id,
      kind,
      uploaderAccountId: ids.next<'Account'>(),
      width: 512,
      height: 512,
      uploadedBytes: 10,
      createdAt: Temporal.Instant.from('2026-10-20T00:00:00Z'),
      renditions,
    });
    return { id, keys: renditions.map((r) => r.objectKey) };
  };

  const imageOf = (slug: string, imageId: string, size = 'large') =>
    imageRead.execute(anonymous(), { slug, imageId, size });
  const NOT_FOUND = { ok: false, error: { code: 'image.not-found' } };

  it('adds the About text, logo and banner to one store, and only the logo to the list', async () => {
    const sellerId = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z', { minimum: null });
    await setAbout(sellerId, 'We bake.\nEvery day.');
    const logo = await setImage(sellerId, 'logo');
    const banner = await setImage(sellerId, 'banner');

    const one = await read.execute(anonymous(), { slug: 'alpha-market' });
    const all = await page();

    expect(one).toMatchObject({
      ok: true,
      value: {
        about: 'We bake.\nEvery day.',
        logo: { id: logo.id, width: 512, height: 512 },
        banner: { id: banner.id, width: 512, height: 512 },
      },
    });
    expect(all.items[0]).toMatchObject({ logo: { id: logo.id } });
    expect(all.items[0]).not.toHaveProperty('about');
    expect(all.items[0]).not.toHaveProperty('banner');
  });

  it('shows no store page text for a store that may not sell, and no logo in the list', async () => {
    const sellerId = addStore('held-back', 'Held', '2026-01-10T00:00:00Z', { state: 'suspended' });
    await setAbout(sellerId, 'Hidden');
    await setImage(sellerId, 'logo');

    expect((await page()).items).toEqual([]);
    expect(await read.execute(anonymous(), { slug: 'held-back' })).toEqual({
      ok: false,
      error: { code: 'sellers.store-not-found' },
    });
  });

  it('answers sellers.unavailable, not a store without its text, when the content cannot be read', async () => {
    const sellerId = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z');
    storeContent.addProfile(market(), sellerId);
    await setImage(sellerId, 'logo');
    objectStore.objects.clear();
    storeImages.currentOf = () => Promise.reject(new Error('images down'));
    storeImages.logosOf = () => Promise.reject(new Error('images down'));

    expect(await read.execute(anonymous(), { slug: 'alpha-market' })).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
    expect(await list.execute(anonymous(), {})).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
  });

  describe('the public image bytes', () => {
    it('serves the current logo or banner of a store that may sell, both sizes, as JPEG', async () => {
      const sellerId = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z');
      const logo = await setImage(sellerId, 'logo');

      const large = await imageOf('alpha-market', logo.id, 'large');
      const small = await imageOf('alpha-market', logo.id, 'small');

      expect(large).toEqual({
        ok: true,
        value: { bytes: Buffer.from(`${logo.id}:large`), contentType: 'image/jpeg' },
      });
      expect(small).toMatchObject({ ok: true, value: { bytes: Buffer.from(`${logo.id}:small`) } });
    });

    it('answers one identical not-found for every other case', async () => {
      const mine = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z');
      const theirs = addStore('beta-market', 'Beta', '2026-01-10T00:00:00Z');
      const suspended = addStore('held-back', 'Held', '2026-01-10T00:00:00Z', {
        state: 'suspended',
      });
      const first = await setImage(mine, 'logo');
      const other = await setImage(theirs, 'logo');
      const held = await setImage(suspended, 'logo');
      const second = await setImage(mine, 'logo'); // replaces `first`

      const cases = [
        await imageOf('alpha-market', first.id), // replaced
        await imageOf('alpha-market', other.id), // another store's
        await imageOf('beta-market', second.id), // the other way round
        await imageOf('held-back', held.id), // a store that may not sell
        await imageOf('no-such-store', second.id), // unknown slug
        await imageOf('Alpha-Market', second.id), // slug in another case
        await imageOf('alpha-market', 'not-an-id'), // malformed id
        await imageOf('alpha-market', second.id, 'huge'), // unknown size
        await imageOf('alpha-market', second.id, 'thumb'),
        await imageOf('alpha-market', '0199dddd-0000-7000-8000-000000000999'), // unknown id
      ];

      for (const answer of cases) expect(answer).toEqual(NOT_FOUND);
      expect(await imageOf('alpha-market', second.id)).toMatchObject({ ok: true });
    });

    it('never serves a removed image, and says not-found when the object is missing', async () => {
      const sellerId = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z');
      const banner = await setImage(sellerId, 'banner');
      objectStore.objects.delete(banner.keys[0]!);
      expect(await imageOf('alpha-market', banner.id, 'large')).toEqual(NOT_FOUND);

      await storeImages.remove(market(), sellerId, 'banner');

      expect(await imageOf('alpha-market', banner.id, 'small')).toEqual(NOT_FOUND);
    });

    it('answers not-found, never an image, while identity is down (fail closed)', async () => {
      const sellerId = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z');
      const logo = await setImage(sellerId, 'logo');
      identityDown = true;

      expect(await imageOf('alpha-market', logo.id)).toEqual({
        ok: false,
        error: { code: 'image.not-found' },
      });
    });
  });

  describe('the seller of a store address (for the storefront product list)', () => {
    it('declares the anonymous rule under its own name', () => {
      expect(PublishedStoreSellerId.access).toEqual({
        name: 'sellers.published-store-seller-id',
        rule: { kind: 'anonymous' },
      });
    });

    it('gives the seller that holds the exact slug while it may sell, and nothing else', async () => {
      const id = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z', { minimum: null });

      const result = await sellerIdRead.execute(anonymous(), { slug: 'alpha-market' });

      expect(result).toEqual(ok(id));
      expect(JSON.stringify(result)).not.toContain('Alpha');
    });

    it.each([
      ['a store that may not sell', 'held-back', 'held-back'],
      ['an unknown slug', 'held-back', 'no-such-store'],
      ['a slug in another case', 'held-back', 'Held-Back'],
      ['a malformed slug', 'held-back', '../x'],
      ['a too short slug', 'held-back', 'ab'],
    ])('answers null alike for %s', async (_name, stored, asked) => {
      addStore(stored, 'Held', '2026-01-10T00:00:00Z', {
        state: asked === stored ? 'suspended' : 'approved',
      });

      expect(await sellerIdRead.execute(anonymous(), { slug: asked })).toEqual(ok(null));
    });

    it('answers null while identity is down (the may-sell contract fails closed)', async () => {
      addStore('a-store', 'A', '2026-01-01T00:00:00Z');
      identityDown = true;

      expect(await sellerIdRead.execute(anonymous(), { slug: 'a-store' })).toEqual(ok(null));
    });

    it('answers sellers.unavailable when the store read fails, never a guess', async () => {
      addStore('a-store', 'A', '2026-01-01T00:00:00Z');
      failStores = true;

      expect(await sellerIdRead.execute(anonymous(), { slug: 'a-store' })).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
    });

    it('is not for the system actor (rule anonymous)', async () => {
      addStore('a-store', 'A', '2026-01-01T00:00:00Z');

      const result = await sellerIdRead.execute(
        testCallContext(market(), 'system', 'store-system-abcd'),
        { slug: 'a-store' },
      );

      expect(result.ok).toBe(false);
    });
  });

  describe('the store addresses of sellers (for the storefront slider links)', () => {
    it('declares the anonymous rule under its own name', () => {
      expect(PublishedStoreSlugs.access).toEqual({
        name: 'sellers.published-store-slugs',
        rule: { kind: 'anonymous' },
      });
    });

    it('gives the slug of each requested seller that may sell, and leaves a suspended one out', async () => {
      const a = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z');
      const held = addStore('held-back', 'Held', '2026-01-10T00:00:00Z', { state: 'suspended' });
      const unrequested = addStore('beta-market', 'Beta', '2026-01-10T00:00:00Z');
      const unknown = ids.next<'Seller'>();

      const result = await slugs.execute(anonymous(), { sellerIds: [a, held, unknown] });

      expect(result).toEqual(ok(new Map([[a, 'alpha-market']])));
      expect(result.ok && result.value.has(unrequested)).toBe(false);
    });

    it('answers sellers.unavailable when the store read fails, never a partial answer', async () => {
      const a = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z');
      failStores = true;

      expect(await slugs.execute(anonymous(), { sellerIds: [a] })).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
    });

    it('is not for the system actor (rule anonymous)', async () => {
      const a = addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z');
      const result = await slugs.execute(testCallContext(market(), 'system', 'store-system-abcd'), {
        sellerIds: [a],
      });
      expect(result.ok).toBe(false);
    });
  });
});
