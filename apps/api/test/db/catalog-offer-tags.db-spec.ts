import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { sha256Hex } from '../../src/modules/catalog/application/tags/claim-query-builder';
import type { Offer } from '../../src/modules/catalog/domain/offer';
import {
  canonicalClaimInputs,
  claimQueriesFor,
  type ClaimFacts,
} from '../../src/modules/catalog/domain/offer-tag';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { allowedDecision, refusedDecision } from '../support/catalog-tag-fakes';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { sqlState } from './sql-state';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Catalog slice 8 on PostgreSQL (catalog data design 3.15, 3.16, 5.1, 7; migration
// 20261017130000_catalog_offer_tags), for both Market fixtures: the CHECKs, the open-tag unique,
// the status_seq trigger, the history-present constraint trigger, the insert-only history, the
// grants, Market independence, and the Offer repository's round trip of tags and history.

const T0 = '2026-10-17T00:00:00Z';
const HASH = `sha256:${'a'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)('catalog offer tags in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
  let sql: Client;
  let owner: Client;
  let persistence: Persistence;
  let offers: PrismaOfferRepository;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    persistence = createPersistence();
    offers = new PrismaOfferRepository(persistence.service, ids);
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await persistence.close();
  });

  const insertSql = (table: string, row: Record<string, unknown>) =>
    `INSERT INTO catalog.${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(', ')})`;
  async function insert(table: string, row: Record<string, unknown>, client = sql) {
    await client.query(insertSql(table, row), Object.values(row));
  }
  const base = (m = market) => ({ market_id: m.marketId, tenant_id: m.tenantId });

  /** A product with one stored revision; answers both ids. */
  async function productWithRevision(
    m = market,
  ): Promise<{ productId: string; revisionId: string }> {
    const productId = uuid7();
    await insert('products', {
      id: productId,
      ...base(m),
      scope: 'PLATFORM',
      owner_seller_id: null,
      created_by_seller_id: null,
      type_code: 'simple',
      variant_model: 'single',
      family_code: 'default',
      product_code: `T${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      status: 'draft',
      own_brand: false,
      last_changed_at: T0,
      version: 1,
      created_at: T0,
    });
    const familyId = uuid7();
    const familyRevisionId = uuid7();
    await insert('attribute_families', {
      id: familyId,
      ...base(m),
      code: `f-${randomUUID().slice(0, 10)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0,
    });
    await insert('attribute_family_revisions', {
      id: familyRevisionId,
      ...base(m),
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: T0,
    });
    const revisionId = uuid7();
    await insert('product_revisions', {
      id: revisionId,
      ...base(m),
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
      author_kind: 'seller',
      author_account_id: uuid7(),
      acting_admin_account_id: null,
      submitted_at: T0,
    });
    return { productId, revisionId };
  }

  async function offerRow(m = market) {
    const { productId, revisionId } = await productWithRevision(m);
    const row = {
      id: uuid7(),
      ...base(m),
      seller_id: uuid7(),
      product_id: productId,
      seller_sku: `SKU-${randomUUID().slice(0, 13)}`,
      condition_code: 'new',
      description: '{}',
      handling: 'SEALED_ORIGINAL',
      attestation_recorded_at: null,
      attestation_account_id: null,
      status: 'published',
      off_sale_type_not_allowed: false,
      off_sale_product_retired: false,
      off_sale_product_not_listed: false,
      off_sale_tag_suspended: false,
      off_sale_description_claim_text: false,
      listed: true,
      submitted_at: T0,
      first_published_at: T0,
      deleted_at: null,
      version: 1,
      created_at: T0,
    };
    await insert('offers', row);
    return { offer: row, revisionId };
  }

  const activeTag = (
    offer: { id: string; seller_id: string },
    revisionId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: uuid7(),
    ...base(),
    offer_id: offer.id,
    seller_id: offer.seller_id,
    type_code: typeCode,
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
    evaluated_at: T0,
    status_changed_at: T0,
    status_seq: 1,
    removed_at: null,
    removed_by_kind: null,
    removed_by_account_id: null,
    created_at: T0,
    ...overrides,
  });

  const historyOf = (tag: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    id: uuid7(),
    market_id: tag['market_id'],
    tenant_id: tag['tenant_id'],
    tag_id: tag['id'],
    offer_id: tag['offer_id'],
    type_code: tag['type_code'],
    from_status: null,
    to_status: tag['status'],
    basis: tag['basis'],
    certificate_kind: tag['certificate_kind'],
    certificate_id: tag['certificate_id'],
    certificate_version_id: tag['certificate_version_id'],
    issuer_id: null,
    policy_revision_id: null,
    copy_revision_id: tag['copy_revision_id'],
    reason_code: null,
    entry_path: 'tag-add',
    status_seq: tag['status_seq'],
    cause_event_id: null,
    actor_kind: 'seller',
    actor_account_id: uuid7(),
    acting_admin_account_id: null,
    occurred_at: T0,
    ...overrides,
  });

  /** Runs statements in one transaction on the application login; answers the SQLSTATE or null. */
  async function inTransaction(work: () => Promise<void>): Promise<string | null> {
    await sql.query('BEGIN');
    try {
      await work();
      await sql.query('COMMIT');
      return null;
    } catch (error) {
      await sql.query('ROLLBACK').catch(() => undefined);
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  /** Inserts a tag with its history row in one transaction; answers the SQLSTATE or null. */
  const insertTag = (tag: Record<string, unknown>, withHistory = true) =>
    inTransaction(async () => {
      await insert('offer_tags', tag);
      if (withHistory) await insert('offer_tag_history', historyOf(tag));
    });

  it('stores a tag with its history row, and refuses one without it at commit', async () => {
    const { offer, revisionId } = await offerRow();
    expect(await insertTag(activeTag(offer, revisionId))).toBeNull();
    const second = await offerRow();
    expect(await insertTag(activeTag(second.offer, second.revisionId), false)).toBe('23001');
  });

  it('checks the tag columns', async () => {
    const { offer, revisionId } = await offerRow();
    const bad = (overrides: Record<string, unknown>) =>
      insertTag(activeTag(offer, revisionId, overrides));
    expect(await bad({ status: 'enabled' })).toBe('23514');
    expect(await bad({ type_code: 'Halal' })).toBe('23514');
    expect(await bad({ basis: 'OTHER' })).toBe('23514');
    // An active row holds a full copy and a badge; no badge in any other status.
    expect(await bad({ badge_data: null })).toBe('23514');
    expect(await bad({ certificate_id: null })).toBe('23514');
    expect(await bad({ inputs_hash: Buffer.alloc(16, 1) })).toBe('23514');
    expect(await bad({ status: 'suspended', last_reason_code: 'no-certificate' })).toBe('23514');
    // A live tag names a published revision; pending-publish names an unpublished one, no badge.
    expect(await bad({ copy_revision_published: false })).toBe('23514');
    expect(
      await bad({ status: 'pending-publish', badge_data: null, copy_revision_published: true }),
    ).toBe('23514');
    expect(await bad({ last_change_cause: 'model-output' })).toBe('23514');
    expect(await bad({ status_seq: 2 })).toBe('23514');
    expect(await bad({ removed_at: T0 })).toBe('23514');
    expect(
      await bad({
        status: 'removed',
        badge_data: null,
        removed_at: T0,
        removed_by_kind: 'system',
        removed_by_account_id: uuid7(),
      }),
    ).toBe('23514');
    expect(
      await bad({
        status: 'pending-publish',
        badge_data: null,
        copy_revision_published: false,
      }),
    ).toBeNull();
  });

  it('keeps one open tag per (Offer, type); a removed one does not count', async () => {
    const { offer, revisionId } = await offerRow();
    const first = activeTag(offer, revisionId);
    expect(await insertTag(first)).toBeNull();
    expect(await insertTag(activeTag(offer, revisionId))).toBe('23505');
    const removed = await inTransaction(async () => {
      await sql.query(
        `UPDATE catalog.offer_tags SET status = 'removed', badge_data = NULL, removed_at = $2,
                removed_by_kind = 'seller', removed_by_account_id = $3, status_seq = 2
          WHERE id = $1`,
        [first.id, T0, uuid7()],
      );
      await insert(
        'offer_tag_history',
        historyOf(first, { from_status: 'active', to_status: 'removed', status_seq: 2 }),
      );
    });
    expect(removed).toBeNull();
    expect(await insertTag(activeTag(offer, revisionId))).toBeNull();
  });

  it('raises status_seq by exactly one with each status change and never otherwise', async () => {
    const { offer, revisionId } = await offerRow();
    const tag = activeTag(offer, revisionId);
    expect(await insertTag(tag)).toBeNull();
    const update = (set: string) =>
      inTransaction(async () => {
        await sql.query(`UPDATE catalog.offer_tags SET ${set} WHERE id = $1`, [tag.id]);
      });
    expect(await update(`status_seq = 2`)).toBe('23514');
    expect(
      await update(
        `status = 'suspended', badge_data = NULL, last_reason_code = 'x', status_seq = 3`,
      ),
    ).toBe('23514');
    expect(await update(`evaluated_at = now()`)).toBeNull();
    // A status change without its history row fails at commit.
    expect(
      await update(
        `status = 'suspended', badge_data = NULL, last_reason_code = 'x', status_seq = 2`,
      ),
    ).toBe('23001');
  });

  it('binds a tag to an Offer of its own Market and its seller', async () => {
    const { offer, revisionId } = await offerRow();
    expect(await insertTag(activeTag(offer, revisionId, { seller_id: uuid7() }))).toBe('23503');
    expect(await insertTag(activeTag(offer, revisionId, base(other)))).toBe('23503');
    const elsewhere = await offerRow(other);
    expect(
      await insertTag(activeTag(offer, revisionId, { copy_revision_id: elsewhere.revisionId })),
    ).toBe('23503');
  });

  it('grants no DELETE and no update of the identity columns; the history is insert-only', async () => {
    const { offer, revisionId } = await offerRow();
    const tag = activeTag(offer, revisionId);
    expect(await insertTag(tag)).toBeNull();
    expect(await sqlState(sql, `DELETE FROM catalog.offer_tags WHERE false`)).toBe('42501');
    for (const column of ['type_code', 'offer_id', 'seller_id', 'market_id', 'created_at']) {
      expect(
        await sqlState(sql, `UPDATE catalog.offer_tags SET ${column} = ${column} WHERE false`),
      ).toBe('42501');
    }
    expect(
      await sqlState(sql, `UPDATE catalog.offer_tag_history SET reason_code = NULL WHERE false`),
    ).toBe('42501');
    expect(await sqlState(sql, `DELETE FROM catalog.offer_tag_history WHERE false`)).toBe('42501');
    expect(
      await sqlState(
        owner,
        `UPDATE catalog.offer_tag_history SET reason_code = NULL WHERE tag_id = $1`,
        [tag.id],
      ),
    ).toBe('23001');
    expect(await sqlState(owner, `TRUNCATE catalog.offer_tag_history CASCADE`)).toBe('23001');
  });

  describe('the Offer repository', () => {
    const actor = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };
    const now = Temporal.Instant.from(T0);
    const certificate = {
      certificateId: uuid7() as Id,
      versionId: uuid7() as Id,
      typeRevisionId: uuid7() as Id,
    };

    const run = async <T>(target: typeof market, work: () => Promise<T>): Promise<T> => {
      const result = await persistence.unitOfWork.run(target, async () => ({
        ok: true as const,
        value: await work(),
      }));
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };

    async function storedOffer(): Promise<{ offer: Offer; facts: ClaimFacts }> {
      const { offer: row, revisionId } = await offerRow();
      const found = await run(market, () => offers.findById(market, row.id as Id<'Offer'>));
      if (found === null) throw new Error('no Offer');
      return {
        offer: found,
        facts: {
          productId: row.product_id as Id<'Product'>,
          productRevisionId: revisionId as Id<'ProductRevision'>,
          revisionPublished: true,
          variantIds: [uuid7() as Id<'Variant'>, uuid7() as Id<'Variant'>],
          platformCategoryPaths: [],
        },
      };
    }

    const decide = (offer: Offer, facts: ClaimFacts, refuse = false) => {
      const queries = claimQueriesFor(offer.state, facts, typeCode)!;
      return {
        decisions: new Map([
          [
            typeCode,
            queries.map((q) =>
              refuse ? refusedDecision(q, 'certificate-expired') : allowedDecision(q, certificate),
            ),
          ],
        ]),
        hash: (canonical: string) => {
          expect(canonical).toBe(canonicalClaimInputs(queries));
          return sha256Hex(canonical);
        },
      };
    };

    it('stores an added tag with its copy and history, reads it back and removes it', async () => {
      const { offer, facts } = await storedOffer();
      const { decisions, hash } = decide(offer, facts);
      const added = offer.addTags({
        tags: [{ tagId: uuid7() as Id<'OfferTag'>, typeCode }],
        facts,
        decisions,
        entryPath: 'tag-add',
        actor,
        hash,
        now,
      });
      expect(added.ok).toBe(true);
      await run(market, () => offers.save(market, offer, actor));
      const read = await run(market, () => offers.findById(market, offer.state.id));
      expect(read?.tags).toEqual(offer.tags);
      expect(read?.state.version).toBe(offer.state.version);
      expect(await run(other, () => offers.findById(other, offer.state.id))).toBeNull();

      expect(read!.removeTag({ typeCode, actor, now }).ok).toBe(true);
      await run(market, () => offers.save(market, read!, actor));
      const after = await run(market, () => offers.findById(market, offer.state.id));
      expect(after?.tags).toEqual([]);
      const history = await owner.query(
        `SELECT from_status, to_status, status_seq, entry_path, actor_kind
           FROM catalog.offer_tag_history WHERE market_id = $1 AND offer_id = $2
          ORDER BY status_seq`,
        [market.marketId, offer.state.id],
      );
      expect(history.rows).toEqual([
        {
          from_status: null,
          to_status: 'active',
          status_seq: 1,
          entry_path: 'tag-add',
          actor_kind: 'seller',
        },
        {
          from_status: 'active',
          to_status: 'removed',
          status_seq: 2,
          entry_path: 'seller-remove',
          actor_kind: 'seller',
        },
      ]);
    });

    it('suspends a tag and takes the Offer off sale in one save', async () => {
      const { offer, facts } = await storedOffer();
      const first = decide(offer, facts);
      offer.addTags({
        tags: [{ tagId: uuid7() as Id<'OfferTag'>, typeCode }],
        facts,
        decisions: first.decisions,
        entryPath: 'tag-add',
        actor,
        hash: first.hash,
        now,
      });
      await run(market, () => offers.save(market, offer, actor));
      const read = (await run(market, () => offers.findById(market, offer.state.id)))!;
      const refused = decide(read, facts, true);
      const settled = read.settleTags({
        facts,
        decisions: refused.decisions,
        entryPath: 'offer-edit',
        actor,
        hash: refused.hash,
        now,
      });
      expect(settled.ok).toBe(true);
      await run(market, () => offers.save(market, read, actor));
      const after = (await run(market, () => offers.findById(market, offer.state.id)))!;
      expect(after.tags[0]).toMatchObject({ status: 'suspended', badge: null, statusSeq: 2 });
      expect(after.state).toMatchObject({ listed: false, offSaleCauses: ['tag-suspended'] });
    });

    it('refuses a save of a tag changed by another unit since the read (StaleAggregateError)', async () => {
      const { offer, facts } = await storedOffer();
      const { decisions, hash } = decide(offer, facts);
      offer.addTags({
        tags: [{ tagId: uuid7() as Id<'OfferTag'>, typeCode }],
        facts,
        decisions,
        entryPath: 'tag-add',
        actor,
        hash,
        now,
      });
      await run(market, () => offers.save(market, offer, actor));
      const a = (await run(market, () => offers.findById(market, offer.state.id)))!;
      const b = (await run(market, () => offers.findById(market, offer.state.id)))!;
      a.removeTag({ typeCode, actor, now });
      await run(market, () => offers.save(market, a, actor));
      b.removeTag({ typeCode, actor, now });
      await expect(run(market, () => offers.save(market, b, actor))).rejects.toThrow();
    });
  });
});

describe.each(TEST_MARKETS)(
  'catalog live category paths in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    let sql: Client;
    let persistence: Persistence;
    let reader: PrismaCategoryPathsReader;

    beforeAll(async () => {
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
      persistence = createPersistence();
      reader = new PrismaCategoryPathsReader(persistence.service);
    });
    afterAll(async () => {
      await sql.end();
      await persistence.close();
    });

    async function category(
      parentId: string | null,
      overrides: Record<string, unknown> = {},
      m = market,
    ): Promise<string> {
      await sql.query(
        `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
       ON CONFLICT DO NOTHING`,
        [m.marketId, m.tenantId],
      );
      const row = {
        id: uuid7(),
        market_id: m.marketId,
        tenant_id: m.tenantId,
        slug: `s-${randomUUID().slice(0, 12)}`,
        parent_id: parentId,
        status: 'active',
        merged_into_id: null,
        vertical_root_code: null,
        created_by_kind: 'seed',
        version: 1,
        created_at: T0,
        ...overrides,
      };
      await sql.query(
        `INSERT INTO catalog.platform_categories (${Object.keys(row).join(', ')})
       VALUES (${Object.keys(row)
         .map((_, i) => `$${i + 1}`)
         .join(', ')})`,
        Object.values(row),
      );
      return row.id;
    }

    const paths = async (target: typeof market, ids: string[]) => {
      const result = await persistence.unitOfWork.run(
        target,
        async () => ({ ok: true as const, value: await reader.livePaths(target, ids) }),
        { readOnly: true },
      );
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };

    it('answers each live path root first, following merges and dropping archived ones', async () => {
      const root = await category(null);
      const child = await category(root);
      const leaf = await category(child);
      const sibling = await category(root);
      const merged = await category(root, { status: 'merged', merged_into_id: sibling });
      const archived = await category(root, { status: 'archived' });
      const underArchived = await category(archived);
      expect(await paths(market, [leaf, merged, archived, underArchived, leaf])).toEqual([
        [root, child, leaf],
        [root, sibling],
      ]);
      expect(await paths(market, [uuid7()])).toEqual([]);
      expect(await paths(other, [leaf])).toEqual([]);
    });
  },
);
