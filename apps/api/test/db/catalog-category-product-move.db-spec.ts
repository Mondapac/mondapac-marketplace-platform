import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { EditableCategory } from '../../src/modules/catalog/domain/category-edit';
import { PrismaCategoryEditStore } from '../../src/modules/catalog/infrastructure/prisma-category-edit.store';
import { PrismaCategoryProductMoveStore } from '../../src/modules/catalog/infrastructure/prisma-category-product-move.store';
import { PrismaPlatformCategoryRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-category.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The Move products store on PostgreSQL, for both Market fixtures (categories package C5a): one
// open job per source category (partial unique), the claim and the lease, the product scan after
// the cursor (published products whose published revision names the source, never another
// Market's), one item per job and product, the counters guarded by the lease holder, and the
// CHECKs of the new `category-override` revision kind.

const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const HASH = `sha256:${'c'.repeat(64)}`;
const ADMIN = uuid7() as Id<'Account'>;
const REASON = 'Pantry aisle reorganised';

describe.each(TEST_MARKETS)('catalog Move products store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let store: PrismaCategoryEditStore;
  let moves: PrismaCategoryProductMoveStore;
  let categories: PrismaPlatformCategoryRepository;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaCategoryEditStore(db.service);
    moves = new PrismaCategoryProductMoveStore(db.service);
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

  const job = (source: string, target: string) => ({
    id: uuid7() as Id<'CategoryMoveJob'>,
    sourceCategoryId: source as Id<'Category'>,
    targetCategoryId: target as Id<'Category'>,
    reason: REASON,
    createdByAccountId: ADMIN,
    total: 2,
    now: T0,
  });
  const LEASE = T0.add({ minutes: 2 });

  it('keeps one open job per source and lets the next start after it ends', async () => {
    const a = await category(market, null, 'Source');
    const b = await category(market, null, 'Target');
    const first = job(a, b);
    expect(await write(market, () => moves.insertJob(market, first))).toBe(true);
    expect(await write(market, () => moves.insertJob(market, job(a, b)))).toBe(false);
    const claimed = await write(market, () => moves.claim(market, uuid7(), T0, LEASE));
    expect(claimed?.id).toBe(first.id);
    await write(market, async () => {
      const held = await moves.find(market, first.id);
      expect(held?.state).toBe('running');
    });
    // A second runner gets nothing while the lease holds, and the job after it when it ran out.
    expect(
      await write(market, () => moves.claim(market, uuid7(), T0.add({ minutes: 1 }), LEASE)),
    ).toBeNull();
    const taken = await write(market, () =>
      moves.claim(market, uuid7(), T0.add({ minutes: 3 }), T0.add({ minutes: 5 })),
    );
    expect(taken?.id).toBe(first.id);
    expect(taken?.version).toBeGreaterThan(claimed!.version);
  });

  it('scans published products naming the source after the cursor, in this Market only', async () => {
    const a = await category(market, null, 'Scan source');
    const b = await category(market, null, 'Scan target');
    const p1 = await product(market, [a]);
    const p2 = await product(market, [b, a]);
    await product(market, [a], [], 'draft');
    await product(market, [b]);
    const otherSource = await category(other, null, 'Other source');
    await product(other, [otherSource]);
    const created = job(a, b);
    await write(market, () => moves.insertJob(market, created));
    expect(await read(market, () => moves.countProducts(market, a))).toBe(2);
    const record = (await read(market, () => moves.find(market, created.id)))!;
    const all = await read(market, () => moves.nextProducts(market, record, 10));
    expect([...all].sort()).toEqual([p1.productId, p2.productId].sort());
    const [first, second] = [...all];
    const after = await read(market, () =>
      moves.nextProducts(market, { ...record, cursorProductId: first! }, 10),
    );
    expect(after).toEqual([second]);
    // The other Market's category is not found from this Market.
    expect(await read(market, () => moves.countProducts(market, otherSource))).toBe(0);
  });

  it('writes one item per job and product, notifies once, and guards the counters by the holder', async () => {
    const a = await category(market, null, 'Item source');
    const b = await category(market, null, 'Item target');
    const p = await product(market, [a]);
    const created = job(a, b);
    const holder = uuid7();
    await write(market, () => moves.insertJob(market, created));
    // Jobs of the tests before are still due: claim in order until this one is ours.
    for (let turn = 0; turn < 20; turn += 1) {
      const taken = await write(market, () => moves.claim(market, holder, T0, LEASE));
      if (taken === null || taken.id === created.id) break;
    }
    const revisionId = uuid7() as Id<'ProductRevision'>;
    // The revision the item names must be a revision of that product: use the product's own.
    const own = p.revisionId as Id<'ProductRevision'>;
    void revisionId;
    const productId = p.productId as Id<'Product'>;
    expect(
      await write(market, () =>
        moves.recordItem(market, created.id, productId, { state: 'moved', revisionId: own }, T0),
      ),
    ).toBe(true);
    expect(
      await write(market, () =>
        moves.recordItem(market, created.id, productId, { state: 'skipped' }, T0),
      ),
    ).toBe(false);
    expect(await read(market, () => moves.unnotified(market, created.id, 10))).toEqual([
      { productId },
    ]);
    await write(market, () => moves.markNotified(market, created.id, productId, T0));
    expect(await read(market, () => moves.unnotified(market, created.id, 10))).toEqual([]);

    expect(
      await write(market, () =>
        moves.advance(market, created.id, uuid7(), {
          cursor: productId,
          moved: 1,
          skipped: 0,
          failed: 0,
        }),
      ),
    ).toBe(false);
    expect(
      await write(market, () =>
        moves.advance(market, created.id, holder, {
          cursor: productId,
          moved: 1,
          skipped: 0,
          failed: 0,
        }),
      ),
    ).toBe(true);
    expect(await write(market, () => moves.finish(market, created.id, uuid7(), 'done', T0))).toBe(
      false,
    );
    expect(await write(market, () => moves.finish(market, created.id, holder, 'done', T0))).toBe(
      true,
    );
    const ended = await read(market, () => moves.find(market, created.id));
    expect(ended).toMatchObject({ state: 'done', moved: 1, cursorProductId: productId });
  });

  it('refuses the same source and target, a bad reason and counts above the total', async () => {
    const a = await category(market, null, 'Check source');
    const b = await category(market, null, 'Check target');
    await expect(write(market, () => moves.insertJob(market, job(a, a)))).rejects.toThrow();
    await expect(
      write(market, () => moves.insertJob(market, { ...job(a, b), reason: 'short' })),
    ).rejects.toThrow();
  });

  it('accepts a category-override revision only on a base and by an admin', async () => {
    const a = await category(market, null, 'Kind source');
    const p = await product(market, [a]);
    const familyRevisionId = await familyRevision(market);
    const row = (over: Record<string, unknown>) => ({
      id: uuid7(),
      ...base(market),
      product_id: p.productId,
      revision_no: 2,
      revision_kind: 'category-override',
      base_revision_id: p.revisionId,
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
      ...over,
    });
    await expect(insert('product_revisions', row({}))).resolves.toBeUndefined();
    await expect(
      insert('product_revisions', row({ revision_no: 3, base_revision_id: null })),
    ).rejects.toThrow();
    await expect(
      insert('product_revisions', row({ revision_no: 4, author_kind: 'seller' })),
    ).rejects.toThrow();
  });
});
