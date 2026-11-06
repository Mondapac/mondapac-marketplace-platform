import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import {
  adminCategoryTree,
  categoryImpact,
} from '../../src/modules/catalog/domain/category-admin-tree';
import { PlatformCategory } from '../../src/modules/catalog/domain/platform-category';
import { PrismaAdminCategoryReader } from '../../src/modules/catalog/infrastructure/prisma-admin-category.reader';
import { PrismaPlatformCategoryRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-category.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The admin category reads on PostgreSQL, for both Market fixtures (categories package C1): every
// status with its published names, the counts folded from published products and their Offers
// (live = a listed Offer; a deleted Offer counts nowhere; an active tag counts once per Offer),
// a product naming two categories of one subtree counted once, the revisions, the Market boundary
// (another Market's category is simply not there) and the time bound of the counts.

const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const HASH = `sha256:${'b'.repeat(64)}`;

describe.each(TEST_MARKETS)('catalog admin categories in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let reader: PrismaAdminCategoryReader;
  let categories: PrismaPlatformCategoryRepository;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    reader = new PrismaAdminCategoryReader(db.service);
    categories = new PrismaPlatformCategoryRepository(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const write = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
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
    const created = PlatformCategory.create({
      id: uuid7() as Id<'Category'>,
      revisionId: uuid7() as Id<'CategoryRevision'>,
      marketId: target.marketId,
      parentId: parentId as Id<'Category'> | null,
      verticalRootCode: null,
      slug: `ac-${uuid7().slice(-12)}`,
      names: [{ locale: 'en-AU', name }],
      createdByKind: 'seed',
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await write(target, () => categories.add(target, created.value));
    return created.value.state.id;
  }

  let familyRevisionId: string | null = null;
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

  interface OfferSpec {
    status?: 'published' | 'deleted';
    listed?: boolean;
    tag?: boolean;
  }

  /** A published product naming `categoryIds` in its published revision, with the given Offers. */
  async function product(
    target: typeof market,
    categoryIds: string[],
    offers: OfferSpec[],
    status = 'published',
  ): Promise<string> {
    familyRevisionId = await familyRevision(target);
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
      product_code: `A${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
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
      const deleted = spec.status === 'deleted';
      const listed = !deleted && spec.listed !== false;
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
        off_sale_product_not_listed: !listed && !deleted,
        off_sale_product_paused: false,
        off_sale_tag_suspended: false,
        off_sale_description_claim_text: false,
        listed,
        submitted_at: deleted ? null : T0.toString(),
        first_published_at: deleted ? null : T0.toString(),
        deleted_at: deleted ? T0.toString() : null,
        version: 1,
        created_at: T0.toString(),
      });
      if (spec.tag === true) {
        const tag = {
          id: uuid7(),
          ...base(target),
          offer_id: offerId,
          seller_id: sellerId,
          type_code: 'halal',
          status: 'active',
          basis: 'SELLER',
          certificate_kind: 'seller',
          certificate_id: uuid7(),
          certificate_version_id: uuid7(),
          issuer_id: null,
          type_revision_id: uuid7(),
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
        };
        await owner.query('BEGIN');
        try {
          await insert('offer_tags', tag);
          await insert('offer_tag_history', {
            id: uuid7(),
            market_id: tag.market_id,
            tenant_id: tag.tenant_id,
            tag_id: tag.id,
            offer_id: offerId,
            type_code: tag.type_code,
            from_status: null,
            to_status: 'active',
            basis: tag.basis,
            certificate_kind: tag.certificate_kind,
            certificate_id: tag.certificate_id,
            certificate_version_id: tag.certificate_version_id,
            issuer_id: null,
            policy_revision_id: null,
            copy_revision_id: revisionId,
            type_revision_id: tag.type_revision_id,
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
    return productId;
  }

  /** Builds the tree of this case: A > B > C, A > D, and a second root E. */
  async function fixture() {
    const a = await category(market, null, 'Alpha');
    const b = await category(market, a, 'Beta');
    const c = await category(market, b, 'Gamma');
    const d = await category(market, a, 'Delta');
    const e = await category(market, null, 'Epsilon');
    return { a, b, c, d, e };
  }

  it('reads every category with the names of its published revision', async () => {
    const t = await fixture();
    const nodes = await run(market, () => reader.categories(market, 5001));
    const mine = nodes.filter((n) => [t.a, t.b, t.c, t.d, t.e].includes(n.id));
    expect(mine.map((n) => [n.parentId, n.status, n.revisionNo, n.names])).toEqual(
      expect.arrayContaining([
        [null, 'active', 1, [{ locale: 'en-AU', name: 'Alpha' }]],
        [t.a, 'active', 1, [{ locale: 'en-AU', name: 'Beta' }]],
      ]),
    );
    expect(mine).toHaveLength(5);
  });

  it('keeps another Market out: its category is not in the list nor in the history', async () => {
    const foreign = await category(other, null, 'Foreign');
    const nodes = await run(market, () => reader.categories(market, 5001));
    expect(nodes.some((n) => n.id === foreign)).toBe(false);
    expect(await run(market, () => reader.revisions(market, foreign, 10))).toEqual([]);
  });

  it('answers the revisions of a category, newest first', async () => {
    const t = await fixture();
    const revisions = await run(market, () => reader.revisions(market, t.b, 10));
    expect(revisions).toEqual([
      {
        revisionNo: 1,
        changeKind: 'created',
        authorKind: 'seed',
        authorAccountId: null,
        parentId: t.a,
        names: [{ locale: 'en-AU', name: 'Beta' }],
        createdAt: T0,
      },
    ]);
  });

  it('counts live products, direct products and Offers up the subtree, once per product', async () => {
    const t = await fixture();
    // Live and tagged, in C and in B (two categories of one subtree: counted once in A and B).
    await product(market, [t.c, t.b], [{ tag: true }, { listed: false }]);
    // Published but no listed Offer: not live; its Offers still count.
    await product(market, [t.d], [{ listed: false }]);
    // A deleted Offer counts nowhere.
    await product(market, [t.d], [{ status: 'deleted' }, {}]);
    // Not published: no fact at all.
    await product(market, [t.c], [{}], 'draft');
    // Another Market's product on another Market's category does not leak.
    const foreign = await category(other, null, 'Foreign');
    await product(other, [foreign], [{}]);

    const nodes = await run(market, () => reader.categories(market, 5001));
    const counted = await run(market, () => reader.productFacts(market, 10_000));
    expect(counted.complete).toBe(true);
    const rows = adminCategoryTree(nodes, 'en-AU', counted.facts);
    const by = (id: string) => rows.find((r) => r.id === id)!.counts;
    expect(by(t.c)).toEqual({ liveProducts: 1, liveProductsDirect: 1, offers: 2 });
    expect(by(t.b)).toEqual({ liveProducts: 1, liveProductsDirect: 1, offers: 2 });
    expect(by(t.d)).toEqual({ liveProducts: 1, liveProductsDirect: 1, offers: 2 });
    expect(by(t.a)).toEqual({ liveProducts: 2, liveProductsDirect: 0, offers: 4 });
    expect(by(t.e)).toEqual({ liveProducts: 0, liveProductsDirect: 0, offers: 0 });

    expect(categoryImpact(nodes, t.a, counted.facts)).toEqual({
      products: 3,
      directProducts: 0,
      offers: 4,
      listedOffers: 2,
      offersWithActiveTag: 1,
      descendants: 3,
    });
    expect(categoryImpact(nodes, t.c, counted.facts)).toMatchObject({
      products: 1,
      directProducts: 1,
      offersWithActiveTag: 1,
    });
  });

  it('pages through the products and stops at the time bound with complete false', async () => {
    const t = await fixture();
    for (let i = 0; i < 5; i += 1) await product(market, [t.e], [{}]);
    const mine = (facts: readonly { categoryIds: readonly string[] }[]) =>
      facts.filter((f) => f.categoryIds.includes(t.e)).length;

    // Small pages, plenty of time: every page is read.
    const paged = new PrismaAdminCategoryReader(db.service, () => 0, 2);
    const all = await run(market, () => paged.productFacts(market, 10_000));
    expect(all.complete).toBe(true);
    expect(mine(all.facts)).toBe(5);

    // A clock that jumps past the bound after the first statement: partial, and says so.
    let tick = 0;
    const slow = new PrismaAdminCategoryReader(db.service, () => (tick += 20_000), 2);
    const partial = await run(market, () => slow.productFacts(market, 10_000));
    expect(partial.complete).toBe(false);
    expect(partial.facts).toHaveLength(2);
  });

  it('reads the tree version, 0 when the Market has no row', async () => {
    const version = await run(market, () => reader.treeVersion(market));
    expect(Number.isInteger(version)).toBe(true);
    expect(version).toBeGreaterThanOrEqual(0);
  });
});
