import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, IdGenerator } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ProductFamilyResolver } from '../../src/modules/catalog/application/attributes/product-family-resolver';
import { CategoryMoveProducts } from '../../src/modules/catalog/application/use-cases/category-move-products.use-case';
import { CategoryMoveProductsRun } from '../../src/modules/catalog/application/use-cases/category-move-products-run.use-case';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaAdminCategoryReader } from '../../src/modules/catalog/infrastructure/prisma-admin-category.reader';
import { PrismaAttributeAdminReader } from '../../src/modules/catalog/infrastructure/prisma-attribute-admin.reader';
import { PrismaCategoryAttributeLinkStore } from '../../src/modules/catalog/infrastructure/prisma-category-attribute-link.store';
import { PrismaCategoryEditStore } from '../../src/modules/catalog/infrastructure/prisma-category-edit.store';
import { PrismaCategoryProductMoveStore } from '../../src/modules/catalog/infrastructure/prisma-category-product-move.store';
import { PrismaCategoryTreeReader } from '../../src/modules/catalog/infrastructure/prisma-category-tree.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaTagReevaluationRequests } from '../../src/modules/catalog/infrastructure/prisma-tag-reevaluation-requests';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { RecordingOutbox } from '../support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
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
// CHECKs of the new `category-override` revision kind. And one real move end to end through the
// run use case on the Prisma adapters: the item is written `pending` and turned `moved` once the
// revision row exists (its foreign key), the product publishes the `category-override` revision
// naming the target, and in the same unit its Offers' active tags turn `rechecking` with a pending
// re-ask request naming the new revision; a product whose unit fails leaves none of that behind.

const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const HASH = `sha256:${'c'.repeat(64)}`;
const ADMIN = uuid7() as Id<'Account'>;
const REASON = 'Pantry aisle reorganised';
const ids: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

describe.each(TEST_MARKETS)('catalog Move products store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let store: PrismaCategoryEditStore;
  let moves: PrismaCategoryProductMoveStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaCategoryEditStore(db.service);
    moves = new PrismaCategoryProductMoveStore(db.service);
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
  ): Promise<{ productId: string; revisionId: string; offerIds: string[] }> {
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
    const variantId = uuid7();
    await insert('product_variants', {
      id: variantId,
      ...base(target),
      product_id: productId,
      variant_model: 'single',
      variant_no: 1,
      state: 'published',
      created_at: T0.toString(),
      published_at: T0.toString(),
    });
    await insert('product_revision_texts', {
      ...base(target),
      revision_id: revisionId,
      locale: 'en',
      name: 'Dates',
      short_description: null,
      description: null,
    });
    await insert('product_revision_variants', {
      ...base(target),
      revision_id: revisionId,
      variant_id: variantId,
      product_id: productId,
      position: 0,
      option_key: '',
      option_values: '{}',
      labels: '{}',
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
    const offerIds: string[] = [];
    for (const spec of offers) {
      const deleted = spec.deleted === true;
      const offerId = uuid7();
      offerIds.push(offerId);
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
    return { productId, revisionId, offerIds };
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
    const productId = p.productId as Id<'Product'>;
    // A revision the item may not name: not a revision of this product (the composite foreign key).
    const stranger = await product(market, [a]);
    // The item is written pending (no revision) and turned moved in the same unit, after the
    // revision row exists; here the product's own revision stands in for the move's.
    const own = p.revisionId as Id<'ProductRevision'>;
    expect(
      await write(market, async () => {
        const first = await moves.recordItem(
          market,
          created.id,
          productId,
          { state: 'pending' },
          T0,
        );
        // A duplicate answers false without failing the statement: the unit goes on (no 25P02).
        const again = await moves.recordItem(
          market,
          created.id,
          productId,
          { state: 'skipped' },
          T0,
        );
        const moved = await moves.markMoved(market, created.id, productId, own);
        return [first, again, moved];
      }),
    ).toEqual([true, false, true]);
    expect(
      await write(market, () =>
        moves.recordItem(market, created.id, productId, { state: 'skipped' }, T0),
      ),
    ).toBe(false);
    // Moved only from pending, and never naming another product's revision.
    expect(await write(market, () => moves.markMoved(market, created.id, productId, own))).toBe(
      false,
    );
    const strangerId = stranger.productId as Id<'Product'>;
    await expect(
      write(market, async () => {
        await moves.recordItem(market, created.id, strangerId, { state: 'pending' }, T0);
        return moves.markMoved(market, created.id, strangerId, own);
      }),
    ).rejects.toThrow();
    expect(await read(market, () => moves.unnotified(market, created.id, T0, 10))).toEqual([
      { productId, attempts: 0 },
    ]);
    await write(market, () => moves.markNotified(market, created.id, productId, T0));
    expect(await read(market, () => moves.unnotified(market, created.id, T0, 10))).toEqual([]);
    expect(await read(market, () => moves.hasOpenNotices(market, created.id))).toBe(false);

    expect(await write(market, () => moves.advance(market, created.id, uuid7(), productId))).toBe(
      false,
    );
    expect(await write(market, () => moves.advance(market, created.id, holder, productId))).toBe(
      true,
    );
    expect(await write(market, () => moves.finish(market, created.id, uuid7(), 'done', T0))).toBe(
      false,
    );
    expect(await write(market, () => moves.finish(market, created.id, holder, 'done', T0))).toBe(
      true,
    );
    // The counters are counted from the items (one moved), whatever the runner believes.
    const ended = await read(market, () => moves.find(market, created.id));
    expect(ended).toMatchObject({
      state: 'done',
      moved: 1,
      skipped: 0,
      failed: 0,
      cursorProductId: productId,
    });
  });

  /** Claims in order until `id` is held by `holder` (jobs of the tests before are still due). */
  async function claimJob(id: string, holder: string): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) {
      const taken = await write(market, () => moves.claim(market, holder, T0, LEASE));
      if (taken === null || taken.id === id) return;
    }
  }

  it('retries a failed seller email when due and gives it up at the last attempt (N1)', async () => {
    const a = await category(market, null, 'Notice source');
    const b = await category(market, null, 'Notice target');
    const p = await product(market, [a]);
    const created = job(a, b);
    const holder = uuid7();
    await write(market, () => moves.insertJob(market, created));
    await claimJob(created.id, holder);
    const productId = p.productId as Id<'Product'>;
    await write(market, async () => {
      await moves.recordItem(market, created.id, productId, { state: 'pending' }, T0);
      return moves.markMoved(market, created.id, productId, p.revisionId as Id<'ProductRevision'>);
    });
    const later = T0.add({ minutes: 5 });
    await write(market, () =>
      moves.noticeFailed(market, created.id, productId, { attempts: 1, nextAttemptAt: later }, T0),
    );
    // Waiting: not due before its retry time, but still open (the job cannot end yet).
    expect(await read(market, () => moves.unnotified(market, created.id, T0, 10))).toEqual([]);
    expect(await read(market, () => moves.hasOpenNotices(market, created.id))).toBe(true);
    expect(await read(market, () => moves.unnotified(market, created.id, later, 10))).toEqual([
      { productId, attempts: 1 },
    ]);
    // The last attempt gives it up: no longer open, never due again, and never marked sent.
    await write(market, () =>
      moves.noticeFailed(
        market,
        created.id,
        productId,
        { attempts: 5, nextAttemptAt: null },
        later,
      ),
    );
    expect(
      await read(market, () => moves.unnotified(market, created.id, later.add({ hours: 9 }), 10)),
    ).toEqual([]);
    expect(await read(market, () => moves.hasOpenNotices(market, created.id))).toBe(false);
    await write(market, () => moves.markNotified(market, created.id, productId, later));
    const row = await owner.query<{ attempts: number; failed: boolean; notified: boolean }>(
      `SELECT notice_attempts AS attempts, notice_failed_at IS NOT NULL AS failed,
              seller_notified_at IS NOT NULL AS notified
         FROM catalog.category_product_move_items
        WHERE market_id = $1 AND job_id = $2 AND product_id = $3`,
      [market.marketId, created.id, productId],
    );
    expect(row.rows[0]).toEqual({ attempts: 5, failed: true, notified: false });
    // The CHECK: an email is never both sent and given up.
    await expect(
      owner.query(
        `UPDATE catalog.category_product_move_items SET seller_notified_at = now()
          WHERE market_id = $1 AND job_id = $2`,
        [market.marketId, created.id],
      ),
    ).rejects.toThrow(/category_product_move_items_notice_check/);

    // The pass ends once, under the lease only; the job is then finished by its holder.
    expect(await write(market, () => moves.endScan(market, created.id, uuid7(), 'done'))).toBe(
      false,
    );
    expect(await write(market, () => moves.endScan(market, created.id, holder, 'done'))).toBe(true);
    expect(await write(market, () => moves.endScan(market, created.id, holder, 'failed'))).toBe(
      false,
    );
    expect(await read(market, () => moves.find(market, created.id))).toMatchObject({
      state: 'running',
      scanOutcome: 'done',
      moved: 1,
    });
    expect(await write(market, () => moves.finish(market, created.id, holder, 'done', T0))).toBe(
      true,
    );
  });

  it('counts a committed pending item as failed when the job ends, and turns it failed (N2)', async () => {
    const a = await category(market, null, 'Pending source');
    const b = await category(market, null, 'Pending target');
    const p = await product(market, [a]);
    const created = job(a, b);
    const holder = uuid7();
    await write(market, () => moves.insertJob(market, created));
    await claimJob(created.id, holder);
    // A pending item committed on its own: a product unit that ended without its revision.
    await write(market, () =>
      moves.recordItem(market, created.id, p.productId as Id<'Product'>, { state: 'pending' }, T0),
    );
    expect(await write(market, () => moves.finish(market, created.id, holder, 'done', T0))).toBe(
      true,
    );
    expect(await read(market, () => moves.find(market, created.id))).toMatchObject({
      state: 'done',
      moved: 0,
      skipped: 0,
      failed: 1,
    });
    const item = await owner.query<{ state: string }>(
      `SELECT state FROM catalog.category_product_move_items WHERE market_id = $1 AND job_id = $2`,
      [market.marketId, created.id],
    );
    expect(item.rows).toEqual([{ state: 'failed' }]);
  });

  it('refuses the same source and target, a bad reason and a negative count, but not counts above the total', async () => {
    const a = await category(market, null, 'Check source');
    const b = await category(market, null, 'Check target');
    await expect(write(market, () => moves.insertJob(market, job(a, a)))).rejects.toThrow();
    await expect(
      write(market, () => moves.insertJob(market, { ...job(a, b), reason: 'short' })),
    ).rejects.toThrow();
    const created = job(a, b);
    await write(market, () => moves.insertJob(market, created));
    // The total is a snapshot: products published into the source later are handled too.
    await expect(
      owner.query(
        `UPDATE catalog.category_product_move_jobs SET moved_count = 5, failed_count = 1
           WHERE market_id = $1 AND id = $2`,
        [market.marketId, created.id],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      owner.query(
        `UPDATE catalog.category_product_move_jobs SET skipped_count = -1
           WHERE market_id = $1 AND id = $2`,
        [market.marketId, created.id],
      ),
    ).rejects.toThrow(/category_product_move_jobs_counts_check/);
    await owner.query(
      `UPDATE catalog.category_product_move_jobs
          SET state = 'failed', started_at = now(), finished_at = now()
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, created.id],
    );
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
  describe('one real move through the run use case', () => {
    const audits: { action: string; targetId: string }[] = [];
    const failAuditFor = new Set<string>();
    const outbox = new RecordingOutbox();
    const audit = {
      record: (_c: CallContext, entry: { action: string; targetId: string }) => {
        if (failAuditFor.has(entry.targetId)) return Promise.reject(new Error('audit down'));
        audits.push({ action: entry.action, targetId: entry.targetId });
        return Promise.resolve();
      },
    };
    const clock = new FixedClock(T0.add({ hours: 1 }));
    const adminReader = () => new PrismaAdminCategoryReader(db.service);
    const runner = () =>
      new CategoryMoveProductsRun(gate, {
        unitOfWork: db.unitOfWork,
        moveStore: moves,
        products: new PrismaProductRepository(db.service),
        revisions: new PrismaProductRevisionRepository(db.service),
        familyResolver: new ProductFamilyResolver({
          treeReader: new PrismaCategoryTreeReader(db.service),
          linkStore: new PrismaCategoryAttributeLinkStore(db.service),
          attributeAdminReader: new PrismaAttributeAdminReader(db.service),
          policy,
        }),
        adminCategoryReader: adminReader(),
        policy,
        offers: new PrismaOfferRepository(db.service, ids),
        requests: new PrismaTagReevaluationRequests(db.service),
        outbox,
        audit: audit,
        clock,
        ids,
        ownerContacts: { emailOf: () => Promise.resolve(null) },
        mailSettings: {
          sender: () => ({ address: 'noreply@example.test', name: 'Team' }),
          zone: () => 'UTC',
        },
        mailTransport: { send: () => Promise.reject(new Error('no seller to email')) },
      });

    it('moves a product, publishes the override, re-asks its tags in the same unit, and fails a product whose unit failed with nothing left behind', async () => {
      // Jobs the store tests above left open would be claimed first: close them.
      await owner.query(
        `UPDATE catalog.category_product_move_jobs
            SET state = 'done', started_at = COALESCE(started_at, now()), finished_at = now(),
                lease_holder = NULL, lease_expires_at = NULL
          WHERE market_id = $1 AND state IN ('queued', 'running')`,
        [market.marketId],
      );
      const department = await category(market, null, 'Pantry');
      const group = await category(market, department, 'Dry goods');
      const source = await category(market, group, 'Dates');
      const target = await category(market, group, 'Dried fruit');
      const moved = await product(market, [source], [{ tags: 1 }]);
      const failing = await product(market, [source], [{ tags: 1 }]);
      failAuditFor.add(failing.productId);

      const admin = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ADMIN,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );
      const started = await new CategoryMoveProducts(gate, {
        unitOfWork: db.unitOfWork,
        adminCategoryReader: adminReader(),
        moveStore: moves,
        policy,
        audit: audit,
        clock,
        ids,
      }).execute(admin, { categoryId: source, targetId: target, reason: REASON });
      expect(started).toMatchObject({ ok: true, value: { products: 2 } });
      const jobId = started.ok ? started.value.jobId : ('' as Id<'CategoryMoveJob'>);

      const ran = await runner().execute(testCallContext(market, 'system', 'move-job'), {
        budgetMs: 60_000,
      });
      expect(ran).toMatchObject({
        ok: true,
        value: { ran: true, jobId, outcome: 'done', moved: 1, skipped: 0, failed: 1 },
      });

      // The item names the category-override revision, now the product's published one.
      const items = await owner.query<{
        product_id: string;
        state: string;
        revision_id: string | null;
        notified: boolean;
      }>(
        `SELECT product_id, state, revision_id, seller_notified_at IS NOT NULL AS notified
           FROM catalog.category_product_move_items WHERE market_id = $1 AND job_id = $2`,
        [market.marketId, jobId],
      );
      const itemOf = (productId: string) => items.rows.find((row) => row.product_id === productId);
      const revisionId = itemOf(moved.productId)?.revision_id;
      // A PLATFORM product has no seller to email: marked as told, nothing sent.
      expect(itemOf(moved.productId)).toMatchObject({ state: 'moved', notified: true });
      expect(revisionId).toEqual(expect.any(String));
      expect(itemOf(failing.productId)).toMatchObject({ state: 'failed', revision_id: null });

      const published = await owner.query<{ published_revision_id: string }>(
        `SELECT published_revision_id FROM catalog.products WHERE market_id = $1 AND id = $2`,
        [market.marketId, moved.productId],
      );
      expect(published.rows[0]?.published_revision_id).toBe(revisionId);
      const revision = await owner.query<{
        revision_kind: string;
        base_revision_id: string;
        author_kind: string;
        author_account_id: string;
      }>(
        `SELECT revision_kind, base_revision_id, author_kind, author_account_id
           FROM catalog.product_revisions WHERE market_id = $1 AND id = $2`,
        [market.marketId, revisionId],
      );
      expect(revision.rows[0]).toEqual({
        revision_kind: 'category-override',
        base_revision_id: moved.revisionId,
        author_kind: 'admin',
        author_account_id: ADMIN,
      });
      const categoriesOf = async (id: string | null | undefined) =>
        (
          await owner.query<{ category_id: string }>(
            `SELECT category_id FROM catalog.product_revision_categories
              WHERE market_id = $1 AND revision_id = $2 ORDER BY position`,
            [market.marketId, id],
          )
        ).rows.map((row) => row.category_id);
      expect(await categoriesOf(revisionId)).toEqual([target]);

      // The Offer's active tag is rechecking through the publish path, with a pending re-ask of
      // the new revision: written in the publish unit (M1).
      const tagsOf = async (offerId: string) =>
        (
          await owner.query<{ status: string; entry_path: string | null }>(
            `SELECT t.status,
                    (SELECT h.entry_path FROM catalog.offer_tag_history h
                      WHERE h.market_id = t.market_id AND h.tag_id = t.id
                      ORDER BY h.change_seq DESC LIMIT 1) AS entry_path
               FROM catalog.offer_tags t WHERE t.market_id = $1 AND t.offer_id = $2`,
            [market.marketId, offerId],
          )
        ).rows;
      const requestsOf = async (productId: string) =>
        (
          await owner.query<{ state: string; product_revision_id: string }>(
            `SELECT state, product_revision_id FROM catalog.tag_reevaluation_requests
              WHERE market_id = $1 AND product_id = $2`,
            [market.marketId, productId],
          )
        ).rows;
      expect(await tagsOf(moved.offerIds[0]!)).toEqual([
        { status: 'rechecking', entry_path: 'revision-publish' },
      ]);
      expect(await requestsOf(moved.productId)).toEqual([
        { state: 'pending', product_revision_id: revisionId },
      ]);

      // The failed product's unit rolled back whole: still on the source, tag still active, no
      // request and no override revision.
      const failedProduct = await owner.query<{ published_revision_id: string }>(
        `SELECT published_revision_id FROM catalog.products WHERE market_id = $1 AND id = $2`,
        [market.marketId, failing.productId],
      );
      expect(failedProduct.rows[0]?.published_revision_id).toBe(failing.revisionId);
      expect(await tagsOf(failing.offerIds[0]!)).toEqual([
        { status: 'active', entry_path: 'tag-add' },
      ]);
      expect(await requestsOf(failing.productId)).toEqual([]);
      const overrides = await owner.query(
        `SELECT 1 FROM catalog.product_revisions
          WHERE market_id = $1 AND product_id = $2 AND revision_kind = 'category-override'`,
        [market.marketId, failing.productId],
      );
      expect(overrides.rowCount).toBe(0);

      // The job is done, its counters counted from the items; the audit names the moved product.
      expect(await read(market, () => moves.find(market, jobId))).toMatchObject({
        state: 'done',
        total: 2,
        moved: 1,
        skipped: 0,
        failed: 1,
      });
      expect(audits).toContainEqual({
        action: 'catalog.product.category-overridden',
        targetId: moved.productId,
      });
      expect(audits.some((entry) => entry.targetId === failing.productId)).toBe(false);
    });
  });
});
