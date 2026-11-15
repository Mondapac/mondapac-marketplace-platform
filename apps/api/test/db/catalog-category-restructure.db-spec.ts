import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, PendingEvent, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { CategoryRestructureDependencies } from '../../src/modules/catalog/application/categories/category-restructure';
import { CategoryArchive } from '../../src/modules/catalog/application/use-cases/category-archive.use-case';
import { CategoryMerge } from '../../src/modules/catalog/application/use-cases/category-merge.use-case';
import { CategoryMove } from '../../src/modules/catalog/application/use-cases/category-move.use-case';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaTagReevaluationRequests } from '../../src/modules/catalog/infrastructure/prisma-tag-reevaluation-requests';
import { NO_COUNTS } from '../../src/modules/catalog/application/ports/tag-reevaluation-requests';
import type { EditableCategory } from '../../src/modules/catalog/domain/category-edit';
import { runStructural } from '../../src/modules/catalog/application/categories/category-editor';
import { PrismaCategoryEditStore } from '../../src/modules/catalog/infrastructure/prisma-category-edit.store';
import { PrismaPlatformCategoryRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-category.repository';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The move, merge and archive store on PostgreSQL, for both Market fixtures (categories package
// C4a): a move writes the new parent on the row and on its revision, with the reason; a merge
// sets `merged` and `merged_into_id` together (the CHECK); the database refuses a cycle on its
// own; the product reads count only published products' published revisions, per category, and
// never another Market's; an archive is refused while a product has no other live platform
// category (AC 4); the active tags of non-deleted Offers; business activities follow a merge and
// leave an archive. The use cases are in category-restructure.use-cases.spec.ts.

const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const HASH = `sha256:${'c'.repeat(64)}`;
const ADMIN = uuid7() as Id<'Account'>;
const REASON = 'Pantry aisle reorganised';

describe.each(TEST_MARKETS)(
  'catalog category restructure store in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    let db: Persistence;
    let owner: Client;
    let store: PrismaCategoryEditStore;
    let categories: PrismaPlatformCategoryRepository;

    beforeAll(async () => {
      db = createPersistence();
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      store = new PrismaCategoryEditStore(db.service);
      categories = new PrismaPlatformCategoryRepository(db.service);
    });
    afterAll(async () => {
      await owner.end();
      await db.close();
    });

    const write = async <T>(target: typeof market, work: () => Promise<T>) => {
      const result = await db.unitOfWork.run(target, async () => ok(await work()));
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };
    const read = async <T>(target: typeof market, work: () => Promise<T>) => {
      const result = await db.unitOfWork.run(target, async () => ok(await work()), {
        readOnly: true,
      });
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };
    const insert = async (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row);
      await owner.query(
        `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    const base = (target: typeof market) => ({
      market_id: target.marketId,
      tenant_id: target.tenantId,
    });

    async function category(
      target: typeof market,
      parentId: string | null,
      name: string,
    ): Promise<Id<'Category'>> {
      const id = uuid7() as Id<'Category'>;
      await write(target, () =>
        store.insert(target, {
          id,
          revisionId: uuid7() as Id<'CategoryRevision'>,
          parentId: parentId as Id<'Category'> | null,
          slug: `rs-${uuid7().slice(-12)}`,
          texts: [{ locale: 'en-AU', name, shortDescription: null, keywords: [] }],
          seo: { title: null, description: null, noindex: false },
          showInMenu: true,
          authorAccountId: ADMIN,
          now: T0,
        }),
      );
      return id;
    }
    const load = async (target: typeof market, id: string): Promise<EditableCategory> => {
      const all = await read(target, () => store.loadAll(target, 10_000));
      const found = all.find((node) => node.id === id);
      if (found === undefined) throw new Error('category not found');
      return found;
    };
    const apply = async (
      target: typeof market,
      id: string,
      kind: 'moved' | 'merged' | 'archived',
      patch: Parameters<typeof store.apply>[1]['patch'],
      reason?: string,
    ) => {
      const current = await load(target, id);
      return write(target, () =>
        store.apply(target, {
          category: current,
          revisionId: uuid7() as Id<'CategoryRevision'>,
          kind,
          texts: current.texts,
          patch,
          authorAccountId: ADMIN,
          now: T0,
          ...(reason === undefined ? {} : { reason }),
        }),
      );
    };

    async function familyRevision(target: typeof market): Promise<string> {
      const familyId = uuid7();
      const revisionId = uuid7();
      await insert('attribute_families', {
        id: familyId,
        ...base(target),
        code: `f-${uuid7().slice(-10)}`,
        status: 'active',
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      });
      await insert('attribute_family_revisions', {
        id: revisionId,
        ...base(target),
        family_id: familyId,
        revision_no: 1,
        groups: '[]',
        author_kind: 'seed',
        created_at: T0.toString(),
      });
      return revisionId;
    }

    /** A product naming `categoryIds` in its revision, published unless asked; Offers with tags. */
    async function product(
      target: typeof market,
      categoryIds: string[],
      offers: { deleted?: boolean; tags?: number }[] = [],
      status: 'published' | 'draft' = 'published',
    ): Promise<{ productId: string; revisionId: string }> {
      const familyRevisionId = await familyRevision(target);
      const productId = uuid7();
      const revisionId = uuid7();
      await insert('products', {
        id: productId,
        ...base(target),
        scope: 'PLATFORM',
        owner_seller_id: null,
        created_by_seller_id: null,
        type_code: 'simple',
        variant_model: 'single',
        family_code: 'default',
        product_code: `R${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
        status: 'draft',
        own_brand: false,
        last_changed_at: T0.toString(),
        version: 1,
        created_at: T0.toString(),
      });
      await insert('product_revisions', {
        id: revisionId,
        ...base(target),
        product_id: productId,
        revision_no: 1,
        revision_kind: 'submission',
        type_code: 'simple',
        base_revision_id: null,
        reverted_from_revision_id: null,
        family_revision_id: familyRevisionId,
        definition_revision_ids: [],
        tax_category_code: 'standard',
        attribute_values: '{}',
        field_provenance: null,
        sensitive: false,
        sensitive_reasons: [],
        content_schema_version: 1,
        content_hash: HASH,
        author_kind: 'admin',
        author_account_id: uuid7(),
        acting_admin_account_id: null,
        submitted_at: T0.toString(),
      });
      for (const [index, categoryId] of categoryIds.entries()) {
        await insert('product_revision_categories', {
          ...base(target),
          revision_id: revisionId,
          category_id: categoryId,
          position: index,
        });
      }
      if (status === 'published') {
        await owner.query(
          `UPDATE catalog.products SET status = 'published', published_revision_id = $3
           WHERE market_id = $1 AND id = $2`,
          [target.marketId, productId, revisionId],
        );
      }
      for (const spec of offers) {
        const deleted = spec.deleted === true;
        const offerId = uuid7();
        const sellerId = uuid7();
        await insert('offers', {
          id: offerId,
          ...base(target),
          seller_id: sellerId,
          product_id: productId,
          seller_sku: `SKU-${uuid7().slice(-12)}`,
          condition_code: 'new',
          description: '{}',
          handling: deleted ? null : 'SEALED_ORIGINAL',
          attestation_recorded_at: null,
          attestation_account_id: null,
          status: deleted ? 'deleted' : 'published',
          off_sale_type_not_allowed: false,
          off_sale_product_retired: false,
          off_sale_product_not_listed: false,
          off_sale_product_paused: false,
          off_sale_tag_suspended: false,
          off_sale_description_claim_text: false,
          listed: !deleted,
          submitted_at: deleted ? null : T0.toString(),
          first_published_at: deleted ? null : T0.toString(),
          deleted_at: deleted ? T0.toString() : null,
          version: 1,
          created_at: T0.toString(),
        });
        const typeCodes = ['halal', 'kosher', 'vegan'].slice(0, spec.tags ?? 0);
        for (const typeCode of typeCodes) {
          const tagId = uuid7();
          const certificateId = uuid7();
          const certificateVersionId = uuid7();
          const typeRevisionId = uuid7();
          await owner.query('BEGIN');
          try {
            await insert('offer_tags', {
              id: tagId,
              ...base(target),
              offer_id: offerId,
              seller_id: sellerId,
              type_code: typeCode,
              status: 'active',
              basis: 'SELLER',
              certificate_kind: 'seller',
              certificate_id: certificateId,
              certificate_version_id: certificateVersionId,
              issuer_id: null,
              type_revision_id: typeRevisionId,
              policy_revision_id: null,
              valid_until: null,
              badge_data: '{"typeCode":"x"}',
              copy_revision_id: revisionId,
              copy_revision_published: true,
              inputs_hash: Buffer.alloc(32, 1),
              last_reason_code: null,
              last_change_cause: 'tag-add',
              evaluated_at: T0.toString(),
              status_changed_at: T0.toString(),
              change_seq: 1,
              removed_at: null,
              removed_by_kind: null,
              removed_by_account_id: null,
              created_at: T0.toString(),
            });
            await insert('offer_tag_history', {
              id: uuid7(),
              ...base(target),
              tag_id: tagId,
              offer_id: offerId,
              type_code: typeCode,
              from_status: null,
              to_status: 'active',
              basis: 'SELLER',
              certificate_kind: 'seller',
              certificate_id: certificateId,
              certificate_version_id: certificateVersionId,
              issuer_id: null,
              policy_revision_id: null,
              copy_revision_id: revisionId,
              type_revision_id: typeRevisionId,
              valid_until: null,
              reason_code: null,
              entry_path: 'tag-add',
              change_seq: 1,
              cause_event_id: null,
              actor_kind: 'seller',
              actor_account_id: uuid7(),
              acting_admin_account_id: null,
              occurred_at: T0.toString(),
            });
            await owner.query('COMMIT');
          } catch (error) {
            await owner.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        }
      }
      return { productId, revisionId };
    }

    async function activity(target: typeof market, categoryIds: string[]): Promise<string> {
      const id = uuid7();
      await insert('business_activities', {
        id,
        ...base(target),
        code: `act-${uuid7().slice(-10)}`,
        description: null,
        status: 'active',
        created_by: ADMIN,
        created_at: T0.toString(),
        updated_at: T0.toString(),
        version: 1,
      });
      for (const categoryId of categoryIds) {
        await insert('business_activity_categories', {
          ...base(target),
          activity_id: id,
          category_id: categoryId,
          created_at: T0.toString(),
        });
      }
      return id;
    }
    const activityLinks = async (target: typeof market, activityId: string) =>
      (
        await owner.query<{ category_id: string }>(
          `SELECT category_id FROM catalog.business_activity_categories
          WHERE market_id = $1 AND activity_id = $2 ORDER BY category_id`,
          [target.marketId, activityId],
        )
      ).rows.map((row) => row.category_id);

    it('moves a category: the new parent on the row and on its revision, with the reason', async () => {
      const a = await category(market, null, 'Alpha');
      const b = await category(market, a, 'Beta');
      const e = await category(market, null, 'Epsilon');
      const version = await apply(market, b, 'moved', { parentId: e, position: 0 }, REASON);
      expect(version).toBe(2);
      expect(await load(market, b)).toMatchObject({ parentId: e, position: 0, revisionNo: 2 });
      const revisions = await owner.query<{
        change_kind: string;
        parent_id: string | null;
        reason: string | null;
      }>(
        `SELECT change_kind, parent_id, reason FROM catalog.platform_category_revisions
        WHERE market_id = $1 AND category_id = $2 ORDER BY revision_no`,
        [market.marketId, b],
      );
      expect(revisions.rows).toEqual([
        { change_kind: 'created', parent_id: a, reason: null },
        { change_kind: 'moved', parent_id: e, reason: REASON },
      ]);
    });

    it('lets one of two concurrent moves on the same tree version through; the other is stale', async () => {
      const a = await category(market, null, 'Alpha');
      const b = await category(market, a, 'Beta');
      const e = await category(market, null, 'Epsilon');
      const f = await category(market, null, 'Phi');
      const { version } = await write(market, () => categories.treeVersion(market));
      const moveTo = (parentId: Id<'Category'>) =>
        runStructural(
          { unitOfWork: db.unitOfWork, categories, store },
          market,
          version,
          async (nodes) => {
            const current = nodes.find((node) => node.id === b)!;
            await store.apply(market, {
              category: current,
              revisionId: uuid7() as Id<'CategoryRevision'>,
              kind: 'moved',
              texts: current.texts,
              patch: { parentId, position: 0 },
              authorAccountId: ADMIN,
              now: T0,
              reason: REASON,
            });
            return ok(parentId);
          },
        );
      const answers = await Promise.all([moveTo(e), moveTo(f)]);
      const won = answers.filter((answer) => answer.ok);
      expect(won).toHaveLength(1);
      expect(answers.filter((answer) => !answer.ok)).toEqual([
        { ok: false, error: { code: 'conflict.stale' } },
      ]);
      expect((await load(market, b)).parentId).toBe(won[0]!.ok ? won[0]!.value : null);
      expect((await write(market, () => categories.treeVersion(market))).version).toBe(version + 1);
    });

    it('refuses a cycle in the database too, whatever the caller planned', async () => {
      const a = await category(market, null, 'Alpha');
      const b = await category(market, a, 'Beta');
      await expect(apply(market, a, 'moved', { parentId: b, position: 0 })).rejects.toThrow(
        /cycle/,
      );
      expect((await load(market, a)).parentId).toBeNull();
    });

    it('merges: `merged` and `merged_into_id` together, the children under the target', async () => {
      const a = await category(market, null, 'Alpha');
      const b = await category(market, a, 'Beta');
      const c = await category(market, b, 'Gamma');
      const d = await category(market, a, 'Delta');
      await write(market, async () => {
        const source = await store.loadAll(market, 10_000);
        const child = source.find((node) => node.id === c)!;
        await store.apply(market, {
          category: child,
          revisionId: uuid7() as Id<'CategoryRevision'>,
          kind: 'moved',
          texts: child.texts,
          patch: { parentId: d, position: 0 },
          authorAccountId: ADMIN,
          now: T0,
        });
        const merged = source.find((node) => node.id === b)!;
        await store.apply(market, {
          category: merged,
          revisionId: uuid7() as Id<'CategoryRevision'>,
          kind: 'merged',
          texts: merged.texts,
          patch: { status: 'merged', hiddenById: null, mergedIntoId: d },
          authorAccountId: ADMIN,
          now: T0,
          reason: REASON,
        });
      });
      const row = await owner.query<{ status: string; merged_into_id: string | null }>(
        `SELECT status, merged_into_id FROM catalog.platform_categories
        WHERE market_id = $1 AND id = $2`,
        [market.marketId, b],
      );
      expect(row.rows).toEqual([{ status: 'merged', merged_into_id: d }]);
      expect((await load(market, c)).parentId).toBe(d);
      // The CHECK holds `merged` and `merged_into_id` together, for every role.
      await expect(
        owner.query(
          `UPDATE catalog.platform_categories SET merged_into_id = NULL
          WHERE market_id = $1 AND id = $2`,
          [market.marketId, b],
        ),
      ).rejects.toThrow(/platform_categories_merged_check/);
    });

    it('counts the published products named per category, never a draft or another Market', async () => {
      const a = await category(market, null, 'Alpha');
      const b = await category(market, a, 'Beta');
      const c = await category(market, b, 'Gamma');
      const d = await category(market, b, 'Delta');
      await product(market, [c]);
      await product(market, [c, d]);
      await product(market, [d], [], 'draft');
      const elsewhere = await category(other, null, 'Elsewhere');
      await product(other, [elsewhere]);
      const counts = await read(market, () =>
        store.directProducts(market, [a, b, c, d, elsewhere]),
      );
      expect(Object.fromEntries(counts)).toEqual({ [c]: 2, [d]: 1 });
    });

    it('lists, per published product on the categories, the other categories it names (AC 4, M1)', async () => {
      const a = await category(market, null, 'Alpha');
      const c = await category(market, a, 'Gamma');
      const d = await category(market, a, 'Delta');
      const x = await category(market, a, 'Retired');
      await apply(market, x, 'archived', { status: 'archived', hiddenById: null });
      await product(market, [c]); // only here
      await product(market, [c, d]); // also in a live category
      await product(market, [c, x]); // its other category is archived
      await product(market, [c], [], 'draft'); // not published
      const others = async (ids: Id<'Category'>[], limit = 10) =>
        (await read(market, () => store.otherCategoriesOf(market, ids, limit)))
          .map((list) => [...list].sort().join(','))
          .sort();
      expect(await others([c])).toEqual(['', d, x].sort());
      // An id in the list is never "other"; the limit bounds the products.
      expect(await others([c, d])).toEqual(['', '', x].sort());
      expect(await others([c], 2)).toHaveLength(2);
      expect(await others([d])).toEqual([c]);
    });

    it('lists the products under the categories in id order, with the active tags of live Offers', async () => {
      const a = await category(market, null, 'Alpha');
      const c = await category(market, a, 'Gamma');
      const d = await category(market, a, 'Delta');
      const first = await product(market, [c], [{ tags: 2 }, { deleted: true, tags: 1 }]);
      const second = await product(market, [c, d], [{ tags: 1 }]);
      await product(market, [d], [{ tags: 3 }], 'draft');
      const under = await read(market, () => store.productsUnder(market, [c, d], 10));
      expect(under.products).toEqual(
        [first, second]
          .sort((x, y) => (x.productId < y.productId ? -1 : 1))
          .map(({ productId, revisionId }) => ({ productId, revisionId })),
      );
      // Two on the first product's live Offer and one on the second's; the deleted Offer's and the
      // draft product's tags do not count.
      expect(under.activeTags).toBe(3);
      const capped = await read(market, () => store.productsUnder(market, [c, d], 1));
      expect(capped.products).toHaveLength(1);
      expect(await read(other, () => store.productsUnder(other, [c, d], 10))).toEqual({
        products: [],
        activeTags: 0,
      });
    });

    describe('whole actions on PostgreSQL (Sajad 2, #712)', () => {
      const clock = new FixedClock(T0);
      let audits: AuditEntry[];
      let events: PendingEvent[];
      let asked: string[][];
      let deps: CategoryRestructureDependencies;
      let requests: PrismaTagReevaluationRequests;
      const admin = (): CallContext =>
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'admin',
            accountId: ADMIN,
            sessionId: uuid7() as Id<'Session'>,
            sellerId: null,
          }),
        );

      beforeAll(() => {
        const markets = new MarketRegistry(
          loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS),
        );
        const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
        const ids = { next: <K extends string>() => uuid7() as Id<K> };
        requests = new PrismaTagReevaluationRequests(db.service);
        deps = {
          unitOfWork: db.unitOfWork,
          store,
          restructure: store,
          categories,
          policy: new ConfigCatalogMarketPolicy(markets),
          retirement: {
            assertRetirable: (_c, categoryIds) => {
              asked.push([...categoryIds]);
              return Promise.resolve(ok(undefined));
            },
            retired: () => Promise.resolve(ok(undefined)),
          },
          offers: new PrismaOfferRepository(db.service, ids),
          requests,
          audit: {
            record: (_c, entry) => {
              audits.push(entry);
              return Promise.resolve();
            },
          },
          outbox: {
            append: (_c, batch) => {
              events.push(...batch);
              return Promise.resolve();
            },
          },
          clock,
          ids,
        };
        gateOf = () => createUseCaseGate(markets, admitAll);
      });
      let gateOf: () => ReturnType<typeof createUseCaseGate>;
      beforeEach(() => {
        audits = [];
        events = [];
        asked = [];
      });

      /**
       * Runs an action at the stored tree version. Other spec files may raise the Market's tree
       * version between the read and the unit: a stale answer is read again, as an admin reloads.
       */
      const atTreeVersion = async <T, E>(
        run: (treeVersion: number) => Promise<Result<T, E>>,
      ): Promise<Result<T, E>> => {
        for (let attempt = 1; ; attempt += 1) {
          const { version } = await write(market, () => categories.treeVersion(market));
          const answer = await run(version);
          const stale = !answer.ok && (answer.error as { code?: string }).code === 'conflict.stale';
          if (!stale || attempt >= 5) return answer;
        }
      };
      const tagStatuses = async (productId: string) =>
        (
          await owner.query<{ status: string }>(
            `SELECT t.status FROM catalog.offer_tags t
               JOIN catalog.offers o ON o.market_id = t.market_id AND o.id = t.offer_id
              WHERE t.market_id = $1 AND o.product_id = $2 ORDER BY t.status`,
            [market.marketId, productId],
          )
        ).rows.map((row) => row.status);
      const historyPaths = async (productId: string) =>
        (
          await owner.query<{ entry_path: string; to_status: string }>(
            `SELECT h.entry_path, h.to_status FROM catalog.offer_tag_history h
               JOIN catalog.offers o ON o.market_id = h.market_id AND o.id = h.offer_id
              WHERE h.market_id = $1 AND o.product_id = $2 AND h.entry_path <> 'tag-add'`,
            [market.marketId, productId],
          )
        ).rows;
      const requestRows = async (revisionId: string) =>
        (
          await owner.query<{ state: string; cursor_offer_id: string | null }>(
            `SELECT state, cursor_offer_id FROM catalog.tag_reevaluation_requests
              WHERE market_id = $1 AND product_revision_id = $2`,
            [market.marketId, revisionId],
          )
        ).rows;
      /** What the product's own publish wrote: one settled request for the revision. */
      const settledPublishRequest = async (published: {
        productId: string;
        revisionId: string;
      }) => {
        const id = uuid7() as Id<'TagReevaluationRequest'>;
        await write(market, async () => {
          await requests.requestForPublish(market, {
            id,
            productId: published.productId as Id<'Product'>,
            productRevisionId: published.revisionId as Id<'ProductRevision'>,
            now: T0,
          });
          await requests.close(market, id, {
            requestedAt: T0,
            state: 'settled',
            counts: NO_COUNTS,
            now: T0,
          });
        });
      };

      it('moves a subtree: the rows, the tags `rechecking` and the request pending again, in one unit', async () => {
        const a = await category(market, null, 'Alpha');
        const b = await category(market, a, 'Beta');
        const c = await category(market, b, 'Gamma');
        const d = await category(market, null, 'Delta');
        const e = await category(market, d, 'Epsilon');
        const published = await product(market, [c], [{ tags: 2 }]);
        await settledPublishRequest(published);
        const move = new CategoryMove(gateOf(), deps);
        const answer = await atTreeVersion((treeVersion) =>
          move.execute(admin(), { categoryId: c, treeVersion, parentId: e, reason: REASON }),
        );
        expect(answer.ok).toBe(true);
        expect(await load(market, c)).toMatchObject({ parentId: e, position: 0 });
        expect(asked).toEqual([[c, b, a]]);
        expect(await tagStatuses(published.productId)).toEqual(['rechecking', 'rechecking']);
        expect(await historyPaths(published.productId)).toEqual([
          { entry_path: 'category-change', to_status: 'rechecking' },
          { entry_path: 'category-change', to_status: 'rechecking' },
        ]);
        // The publish's request is pending again from the first Offer; still one per revision.
        expect(await requestRows(published.revisionId)).toEqual([
          { state: 'pending', cursor_offer_id: null },
        ]);
        expect(audits.map((entry) => entry.action)).toEqual(['catalog.platform-category.moved']);
        expect(events.map((event) => event.type)).toEqual([
          'catalog.platform-category-changed.v1',
          'catalog.platform-category-moved.v1',
        ]);
        // A second move of the same product writes no second request either.
        const back = await atTreeVersion((treeVersion) =>
          move.execute(admin(), { categoryId: c, treeVersion, parentId: b, reason: REASON }),
        );
        expect(back.ok).toBe(true);
        expect(await requestRows(published.revisionId)).toHaveLength(1);
      });

      it('merges: the children last under the target in their order, activities relinked, products marked', async () => {
        const a = await category(market, null, 'Alpha');
        const b = await category(market, a, 'Beta');
        const c1 = await category(market, b, 'Gamma one');
        const c2 = await category(market, b, 'Gamma two');
        const d = await category(market, a, 'Delta');
        const existing = await category(market, d, 'Delta child');
        const shop = await activity(market, [b]);
        const published = await product(market, [c2], [{ tags: 1 }]);
        await settledPublishRequest(published);
        const merge = new CategoryMerge(gateOf(), deps);
        const answer = await atTreeVersion((treeVersion) =>
          merge.execute(admin(), { categoryId: b, treeVersion, targetId: d, reason: REASON }),
        );
        expect(answer.ok).toBe(true);
        const nodes = await read(market, () => store.loadAll(market, 10_000));
        const under = nodes
          .filter((node) => node.parentId === d)
          .sort((x, y) => x.position - y.position)
          .map((node) => node.id);
        expect(under).toEqual([existing, c1, c2]);
        expect(nodes.find((node) => node.id === b)).toMatchObject({
          status: 'merged',
          mergedIntoId: d,
        });
        expect(await activityLinks(market, shop)).toEqual([d]);
        expect(await tagStatuses(published.productId)).toEqual(['rechecking']);
        expect(await requestRows(published.revisionId)).toEqual([
          { state: 'pending', cursor_offer_id: null },
        ]);
      });

      it('archives a leaf whose products stay elsewhere, checking the ancestors they leave (M1)', async () => {
        const a = await category(market, null, 'Alpha');
        const b = await category(market, a, 'Beta');
        const c = await category(market, b, 'Gamma');
        const x = await category(market, null, 'Xi');
        const y = await category(market, x, 'Upsilon');
        const z = await category(market, y, 'Zeta');
        const shop = await activity(market, [c]);
        const published = await product(market, [c, z], [{ tags: 1 }]);
        await settledPublishRequest(published);
        const archive = new CategoryArchive(gateOf(), deps);
        const answer = await atTreeVersion((treeVersion) =>
          archive.execute(admin(), { categoryId: c, treeVersion, reason: REASON }),
        );
        expect(answer.ok).toBe(true);
        expect((await load(market, c)).status).toBe('archived');
        // The product keeps Zeta, under Xi: Beta and Alpha leave its path.
        expect(asked).toEqual([[c, b, a]]);
        expect(await activityLinks(market, shop)).toEqual([]);
        expect(await tagStatuses(published.productId)).toEqual(['rechecking']);
        expect(await requestRows(published.revisionId)).toEqual([
          { state: 'pending', cursor_offer_id: null },
        ]);
      });

      it('refuses an archive that would leave a product with no live category, writing nothing', async () => {
        const a = await category(market, null, 'Alpha');
        const b = await category(market, a, 'Beta');
        const c = await category(market, b, 'Gamma');
        const published = await product(market, [c], [{ tags: 1 }]);
        const archive = new CategoryArchive(gateOf(), deps);
        const answer = await atTreeVersion((treeVersion) =>
          archive.execute(admin(), { categoryId: c, treeVersion, reason: REASON }),
        );
        expect(answer).toEqual({
          ok: false,
          error: { code: 'category.only-platform-category', total: 1 },
        });
        // New categories are created hidden (plan decision); the refusal leaves it so.
        expect((await load(market, c)).status).toBe('hidden');
        expect(await tagStatuses(published.productId)).toEqual(['active']);
        expect(asked).toEqual([]);
      });
    });

    it('relinks business activities on a merge without a duplicate, and unlinks them on an archive', async () => {
      const a = await category(market, null, 'Alpha');
      const b = await category(market, a, 'Beta');
      const d = await category(market, a, 'Delta');
      const both = await activity(market, [b, d]);
      const onlySource = await activity(market, [b]);
      const relinked = await write(market, () => store.relinkActivities(market, b, d, T0));
      expect(relinked).toBe(2);
      expect(await activityLinks(market, both)).toEqual([d]);
      expect(await activityLinks(market, onlySource)).toEqual([d]);
      const unlinked = await write(market, () => store.relinkActivities(market, d, null, T0));
      expect(unlinked).toBe(2);
      expect(await activityLinks(market, both)).toEqual([]);
      expect(await write(market, () => store.relinkActivities(market, d, null, T0))).toBe(0);
    });
  },
);
