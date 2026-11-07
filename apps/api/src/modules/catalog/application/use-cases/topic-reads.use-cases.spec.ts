import { Temporal } from '@mondapac/shared-kernel';
import type {
  CallContext,
  ContentHash,
  Id,
  MarketContext,
  MarketId,
  Result,
} from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ProductState } from '../../domain/product';
import type { StoredRevision } from '../../domain/stored-revision';
import type { TopicState } from '../../domain/topic';
import type { WorkingCopy } from '../../domain/working-copy';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { TopicBrief, TopicReader } from '../ports/topic.reader';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { OwnProductRead } from './own-product-read.use-case';
import { OwnTopicList } from './own-topic-list.use-case';
import { ProductRevisionAdminRead } from './revision-review-read.use-case';

// The reads of product tags T2 in memory, on both Market fixtures: the seller topic picker
// (active topics of the request's Market only), the topic diff of the revision review, and the
// topic names on the seller's own product read. The tables and the repository are in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const T = (n: number) => `0197a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe.each(['AU', 'ZZ'] as const)('topic reads in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherCode = code === 'AU' ? 'ZZ' : 'AU';
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const locale = policy.locales(market).default;
  const sellerId = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();

  const contextOf = (
    population: 'admin' | 'seller' | 'customer',
    inMarket: MarketContext = market,
  ): CallContext =>
    testCallContext(
      inMarket,
      testAuthenticatedActor(inMarket, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );

  const state = (n: number, over: Partial<TopicState> = {}): TopicState => ({
    id: T(n) as Id<'Topic'>,
    slug: `topic-${n}`,
    group: 'use',
    status: 'active',
    terms: [
      { locale, kind: 'name', text: `Topic ${n}`, key: `topic ${n}` },
      { locale, kind: 'synonym', text: `Alias ${n}`, key: `alias ${n}` },
    ],
    intro: 'A secret intro',
    createdBy: ids.next<'Account'>(),
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...over,
  });

  // The stores of the two Markets, so a leak across Markets shows.
  const topicsByMarket: Record<string, TopicState[]> = {
    [code]: [state(1), state(2, { status: 'archived' }), state(3)],
    [otherCode]: [state(9)],
  };
  let lastQuery: Parameters<TopicReader['list']>[1] | null = null;
  const topicReader: TopicReader = {
    list: (m, query) => {
      lastQuery = query;
      const items = (topicsByMarket[m.marketId] ?? []).filter(
        (topic) => query.status === null || topic.status === query.status,
      );
      return Promise.resolve({ items, nextAfterId: null });
    },
    briefsOf: (m, topicIds) =>
      Promise.resolve(
        (topicsByMarket[m.marketId] ?? [])
          .filter((topic) => topicIds.includes(topic.id))
          .map((topic): TopicBrief => ({
            id: topic.id,
            slug: topic.slug,
            status: topic.status,
            names: Object.fromEntries(
              topic.terms.filter((t) => t.kind === 'name').map((t) => [t.locale, t.text]),
            ),
          })),
      ),
  };
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;

  describe('own-topic.list', () => {
    const useCase = new OwnTopicList(gate, { unitOfWork, topicReader, policy });

    it('lists the active topics of the Market, without synonyms, intro or status', async () => {
      const result = await useCase.execute(contextOf('seller'), {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items.map((item) => item.id)).toEqual([T(1), T(3)]);
      expect(result.value.items[0]).toEqual({
        id: T(1),
        slug: 'topic-1',
        group: 'use',
        name: 'Topic 1',
        names: { [locale]: 'Topic 1' },
      });
      expect(JSON.stringify(result.value)).not.toMatch(/Alias|secret|archived/);
      expect(result.value.maxPerProduct).toBe(10);
      expect(lastQuery).toMatchObject({ status: 'active', group: null });
    });

    it('never shows the topics of another Market (canary)', async () => {
      const result = await useCase.execute(contextOf('seller'), {});
      expect(JSON.stringify(result)).not.toContain(T(9));
      const asOther = testMarketContext(otherCode, 'default');
      const there = await useCase.execute(contextOf('seller', asOther), {});
      expect(there.ok && there.value.items.map((item) => item.id)).toEqual([T(9)]);
    });

    it('passes search, afterId and limit, and refuses a malformed request', async () => {
      await useCase.execute(contextOf('seller'), { search: '  bbq ', afterId: T(1), limit: 5 });
      expect(lastQuery).toMatchObject({ search: 'bbq', afterId: T(1), limit: 5 });
      for (const bad of [
        { limit: 0 },
        { limit: 101 },
        { afterId: 'x' },
        { search: 4 },
        { search: 'x'.repeat(81) },
        { status: 'archived' },
        { market: 'AU' },
      ]) {
        const refused = await useCase.execute(contextOf('seller'), bad);
        expect(!refused.ok && refused.error.code).toBe('validation.failed');
      }
    });

    it('answers a seller only: an admin and a customer are denied', async () => {
      for (const population of ['admin', 'customer'] as const) {
        expect(await useCase.execute(contextOf(population), {})).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });

    it('declares the seller edit key and allows a seller who is not yet approved', () => {
      expect(OwnTopicList.access).toEqual({
        name: 'catalog.own-topic-list',
        rule: { kind: 'permissions', allOf: ['catalog.own-product.edit'] },
        whenSellerNotApproved: 'allow',
      });
    });
  });

  const productState = (over: Partial<ProductState> = {}): ProductState => ({
    id: productId,
    marketId: code as MarketId,
    scope: 'SELLER',
    ownerSellerId: sellerId,
    createdBySellerId: sellerId,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'published',
    discardedAt: null,
    withdrawnAt: null,
    retiredAt: null,
    pausedAt: null,
    pausedByAccountId: null,
    ownBrand: false,
    lastChangedAt: T0,
    version: 3,
    createdAt: T0,
    variants: [],
    publishedRevisionId: null,
    pendingRevisionId: null,
    pendingSubmittedAt: null,
    ...over,
  });
  const revision = (id: Id<'ProductRevision'>, no: number, topicIds: string[]): StoredRevision => ({
    id,
    productId,
    revisionNo: no,
    kind: 'submission',
    baseRevisionId: null,
    revertedFromRevisionId: null,
    sensitive: true,
    sensitiveReasons: ['topics-changed'],
    contentHash: 'sha256:aaaa' as ContentHash,
    authorKind: 'seller',
    authorAccountId: ids.next<'Account'>(),
    actingAdminAccountId: null,
    submittedAt: T0,
    content: {
      texts: { [locale]: { name: 'Dates', shortDescription: null, description: null } },
      categoryIds: [],
      topicIds,
      taxCategoryCode: 'standard',
      attributeValues: {},
      variants: [],
      imageIds: [],
      schemaRef: { familyRevisionId: 'f', definitionRevisionIds: [] },
      contentSchemaVersion: 1,
    },
  });

  const publishedId = ids.next<'ProductRevision'>();
  const pendingId = ids.next<'ProductRevision'>();
  const stored = new Map<string, StoredRevision>();
  const products = (s: ProductState): ProductRepository =>
    ({
      findById: () => Promise.resolve({ state: s }),
    }) as unknown as ProductRepository;
  const revisions = {
    find: (_m: unknown, _p: unknown, id: string) => Promise.resolve(stored.get(id) ?? null),
    history: () => Promise.resolve([]),
    latestChangeRequest: () => Promise.resolve(null),
  } as unknown as ProductRevisionRepository;

  describe('revision.review-read topics', () => {
    const useCase = (withNames: boolean) =>
      new ProductRevisionAdminRead(gate, {
        unitOfWork,
        products: products(productState({ publishedRevisionId: publishedId })),
        revisions,
        sellerNames: { storeNames: () => Promise.resolve(new Map()) },
        gtinRegistry: { duplicatesOf: () => Promise.resolve([]) },
        ...(withNames ? { topicReader, policy } : {}),
      });
    const read = (reader: ProductRevisionAdminRead) =>
      reader.execute(contextOf('admin'), { productId, revisionId: pendingId });

    it('shows the topics added and removed against the published revision, order ignored', async () => {
      stored.set(publishedId, revision(publishedId, 1, [T(1), T(2)]));
      stored.set(pendingId, revision(pendingId, 2, [T(3), T(1)]));
      const result = await read(useCase(true));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.topicDiff).toEqual({ added: [T(3)], removed: [T(2)] });
      expect(result.value.revision.topicIds).toEqual([T(3), T(1)]);
      expect(result.value.published?.topicIds).toEqual([T(1), T(2)]);
      expect(result.value.topicRefs.map((ref) => `${ref.id}:${ref.name}`).sort()).toEqual(
        [`${T(1)}:Topic 1`, `${T(2)}:Topic 2`, `${T(3)}:Topic 3`].sort(),
      );
    });

    it('shows a reorder as no change', async () => {
      stored.set(publishedId, revision(publishedId, 1, [T(1), T(3)]));
      stored.set(pendingId, revision(pendingId, 2, [T(3), T(1)]));
      const result = await read(useCase(true));
      expect(result.ok && result.value.topicDiff).toEqual({ added: [], removed: [] });
    });

    it('shows every topic as added before the first publication, and keeps ids without a reader', async () => {
      stored.set(pendingId, revision(pendingId, 1, [T(1)]));
      const first = new ProductRevisionAdminRead(gate, {
        unitOfWork,
        products: products(productState({ status: 'unpublished', publishedRevisionId: null })),
        revisions,
        sellerNames: { storeNames: () => Promise.resolve(new Map()) },
        gtinRegistry: { duplicatesOf: () => Promise.resolve([]) },
      });
      const result = await read(first);
      expect(result.ok && result.value.topicDiff).toEqual({ added: [T(1)], removed: [] });
      expect(result.ok && result.value.topicRefs).toEqual([]);
    });

    it('does not name a topic of another Market (canary)', async () => {
      stored.set(publishedId, revision(publishedId, 1, []));
      stored.set(pendingId, revision(pendingId, 2, [T(9)]));
      const result = await read(useCase(true));
      expect(result.ok && result.value.topicRefs).toEqual([]);
      expect(result.ok && result.value.topicDiff.added).toEqual([T(9)]);
    });
  });

  describe('own-product.read topics', () => {
    const copyOf = (content: Record<string, unknown>): WorkingCopy => ({
      productId,
      content,
      contentSchemaVersion: 1,
      baseRevisionId: null,
      lastSavedAt: T0,
      lastSavedByAccountId: ids.next<'Account'>(),
    });
    const useCase = (copy: WorkingCopy | null, withReader = true) =>
      new OwnProductRead(gate, {
        unitOfWork,
        products: products(
          productState({ publishedRevisionId: publishedId, pendingRevisionId: pendingId }),
        ),
        workingCopies: { find: () => Promise.resolve(copy) } as unknown as WorkingCopyRepository,
        revisions,
        ownReader: {
          productForm: () => Promise.resolve({ fields: [], categories: [] }),
        } as unknown as OwnCatalogReader,
        policy,
        ...(withReader ? { topicReader } : {}),
      });
    const read = (reader: OwnProductRead) => reader.execute(contextOf('seller'), { productId });

    beforeEach(() => {
      stored.set(publishedId, revision(publishedId, 1, [T(1)]));
      stored.set(pendingId, revision(pendingId, 2, [T(1), T(3)]));
    });

    it('names the topics of the draft, the published and the pending revision once each', async () => {
      const result = await read(useCase(copyOf({ topicIds: [T(2), T(1)] })));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.topicRefs.map((ref) => ref.id).sort()).toEqual([T(1), T(2), T(3)]);
      expect(result.value.topicRefs.find((ref) => ref.id === T(2))).toMatchObject({
        slug: 'topic-2',
        status: 'archived',
        name: 'Topic 2',
      });
      expect(result.value.workingCopy?.content['topicIds']).toEqual([T(2), T(1)]);
      expect(result.value.published?.content.topicIds).toEqual([T(1)]);
      // Listed only once the seller panel can name it (PR 4).
      expect(result.value.sensitiveFields).not.toContain('topics');
    });

    it('reads a draft without topicIds, and a malformed one, as none', async () => {
      for (const content of [{}, { topicIds: 'x' }, { topicIds: [3, 'nope', { a: 1 }] }]) {
        const result = await read(useCase(copyOf(content)));
        expect(result.ok && result.value.topicRefs.map((ref) => ref.id).sort()).toEqual([
          T(1),
          T(3),
        ]);
      }
    });

    it('does not name a topic of another Market (canary), and works without a reader', async () => {
      const result = await read(useCase(copyOf({ topicIds: [T(9)] })));
      expect(result.ok && result.value.topicRefs.map((ref) => ref.id)).not.toContain(T(9));
      const bare = await read(useCase(copyOf({ topicIds: [T(1)] }), false));
      expect(bare.ok && bare.value.topicRefs).toEqual([]);
    });
  });
});
