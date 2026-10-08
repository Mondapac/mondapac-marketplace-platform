import { randomUUID } from 'node:crypto';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Catalog slice 4 on PostgreSQL (catalog data design 3.6 to 3.10, 3.12, 3.26, 5.1, 7), for both
// Market fixtures: the constraints, pointers, insert-only revision tables, the not-retired
// trigger and the grants of the migration. Raw SQL on the application and owner connections.

const T0 = '2026-10-08T00:00:00Z';
const HASH = `sha256:${'a'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog revisions in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
  });

  /** The SQLSTATE of a statement that must fail, or null when it succeeded. */
  async function sqlState(
    client: Client,
    text: string,
    values: unknown[] = [],
  ): Promise<string | null> {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  async function insert(table: string, row: Record<string, unknown>, client = sql) {
    const columns = Object.keys(row);
    await client.query(
      `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }
  const insertState = (table: string, row: Record<string, unknown>) =>
    sqlState(
      sql,
      `INSERT INTO catalog.${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
        .map((_, i) => `$${i + 1}`)
        .join(', ')})`,
      Object.values(row),
    );

  const base = (marketId = market.marketId, tenantId = market.tenantId) => ({
    market_id: marketId,
    tenant_id: tenantId,
  });

  async function product(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = uuid7();
    await insert('products', {
      id,
      ...base(),
      scope: 'PLATFORM',
      owner_seller_id: null,
      created_by_seller_id: null,
      type_code: 'configurable',
      variant_model: 'options',
      family_code: 'default',
      product_code: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      status: 'draft',
      own_brand: false,
      last_changed_at: T0,
      version: 1,
      created_at: T0,
      ...overrides,
    });
    return id;
  }

  async function variant(productId: string, state = 'proposed'): Promise<string> {
    const id = uuid7();
    await insert('product_variants', {
      id,
      ...base(),
      product_id: productId,
      variant_model: 'options',
      state,
      created_at: T0,
    });
    return id;
  }

  async function familyRevision(): Promise<string> {
    const familyId = uuid7();
    const revisionId = uuid7();
    await insert('attribute_families', {
      id: familyId,
      ...base(),
      code: `f-${randomUUID().slice(0, 10)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0,
    });
    await insert('attribute_family_revisions', {
      id: revisionId,
      ...base(),
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: T0,
    });
    return revisionId;
  }

  async function category(): Promise<string> {
    const treeVersion = await sql.query(
      `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
       ON CONFLICT DO NOTHING`,
      [market.marketId, market.tenantId],
    );
    void treeVersion;
    const id = uuid7();
    await insert('platform_categories', {
      id,
      ...base(),
      slug: `s-${randomUUID().slice(0, 12)}`,
      parent_id: null,
      status: 'active',
      merged_into_id: null,
      vertical_root_code: null,
      created_by_kind: 'seed',
      version: 1,
      created_at: T0,
    });
    return id;
  }

  function revisionRow(
    productId: string,
    familyRevisionId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: uuid7(),
      ...base(),
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
      ...overrides,
    };
  }

  async function revision(
    productId: string,
    familyRevisionId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = revisionRow(productId, familyRevisionId, overrides);
    await insert('product_revisions', row);
    return row.id;
  }

  it('checks the revision columns', async () => {
    const p = await product();
    const f = await familyRevision();
    const first = await revision(p, f);
    const bad = (overrides: Record<string, unknown>) =>
      insertState('product_revisions', revisionRow(p, f, { revision_no: 2, ...overrides }));
    expect(await bad({ revision_kind: 'other' })).toBe('23514');
    expect(await bad({ revision_no: 0 })).toBe('23514');
    expect(await bad({ revision_kind: 'tax-override', author_kind: 'admin' })).toBe('23514');
    expect(
      await bad({ revision_kind: 'tax-override', author_kind: 'seller', base_revision_id: first }),
    ).toBe('23514');
    expect(await bad({ revision_kind: 'revert' })).toBe('23514');
    expect(await bad({ reverted_from_revision_id: first })).toBe('23514');
    expect(await bad({ tax_category_code: 'Standard' })).toBe('23514');
    expect(await bad({ attribute_values: '[]' })).toBe('23514');
    expect(await bad({ field_provenance: '[]' })).toBe('23514');
    expect(await bad({ sensitive_reasons: ['nonsense'], sensitive: true })).toBe('23514');
    expect(await bad({ sensitive: false, sensitive_reasons: ['name'] })).toBe('23514');
    expect(await bad({ content_hash: 'sha256:abc' })).toBe('23514');
    // A NULL list would make the list CHECKs evaluate to NULL, which a CHECK accepts (B1).
    expect(await bad({ definition_revision_ids: null })).toBe('23514');
    expect(await bad({ sensitive_reasons: null })).toBe('23514');
    expect(await bad({ sensitive_reasons: [null] })).toBe('23514');
    expect(await bad({ author_kind: 'bot' })).toBe('23514');
    expect(await bad({ acting_admin_account_id: uuid7(), author_kind: 'admin' })).toBe('23514');
    expect(
      await bad({
        revision_kind: 'tax-override',
        author_kind: 'admin',
        base_revision_id: first,
        sensitive: true,
        sensitive_reasons: ['tax-category'],
      }),
    ).toBeNull();
    expect(
      await bad({
        revision_no: 3,
        revision_kind: 'revert',
        reverted_from_revision_id: first,
        acting_admin_account_id: uuid7(),
      }),
    ).toBeNull();
    // One revision number per product.
    expect(await bad({ revision_no: 1 })).toBe('23505');
  });

  it('binds a revision and its references to its own product and Market', async () => {
    const a = await product();
    const b = await product();
    const f = await familyRevision();
    const ofB = await revision(b, f);
    const forA = (overrides: Record<string, unknown>) =>
      insertState('product_revisions', revisionRow(a, f, overrides));
    expect(await forA({ base_revision_id: ofB })).toBe('23503');
    expect(await forA({ revision_kind: 'revert', reverted_from_revision_id: ofB })).toBe('23503');
    expect(await forA({ family_revision_id: uuid7() })).toBe('23503');
    // A child row in the other Market (PM6).
    expect(
      await insertState(
        'product_revisions',
        revisionRow(a, f, { market_id: other.marketId, tenant_id: other.tenantId }),
      ),
    ).toBe('23503');
  });

  it('keeps the two pointers of a product to its own revisions, one revision to one product', async () => {
    const a = await product();
    const b = await product();
    const f = await familyRevision();
    const ra = await revision(a, f);
    const rb = await revision(b, f);
    const point = (id: string, set: string, values: unknown[]) =>
      sqlState(sql, `UPDATE catalog.products SET ${set} WHERE id = $1`, [id, ...values]);

    expect(await point(a, 'published_revision_id = $2', [rb])).toBe('23503');
    expect(await point(a, 'pending_revision_id = $2, pending_submitted_at = $3', [rb, T0])).toBe(
      '23503',
    );
    expect(await point(a, 'pending_revision_id = $2', [ra])).toBe('23514');
    expect(await point(a, 'pending_submitted_at = $2', [T0])).toBe('23514');
    expect(await point(a, `status = 'published'`, [])).toBe('23514');
    expect(await point(a, 'published_revision_id = $2', [ra])).toBeNull();
    // Pending equal to published is refused; a revision belongs to one product.
    expect(await point(a, 'pending_revision_id = $2, pending_submitted_at = $3', [ra, T0])).toBe(
      '23514',
    );
    // The partial unique answers before the foreign key: a revision belongs to one product.
    expect(await point(b, 'published_revision_id = $2', [ra])).toBe('23505');
    const rb2 = await revision(b, f, { revision_no: 2 });
    expect(
      await point(b, 'pending_revision_id = $2, pending_submitted_at = $3', [rb2, T0]),
    ).toBeNull();
    expect(await point(b, 'published_revision_id = $2', [rb2])).toBe('23514');
    // A discarded product has no pointer.
    expect(await point(a, `status = 'discarded', discarded_at = $2`, [T0])).toBe('23514');
    expect(await point(a, `status = 'published'`, [])).toBeNull();
    // The partial unique is the index of the published-revision join (A9).
    const index = await sql.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'catalog' AND indexname = 'products_market_id_published_revision_id_key'`,
    );
    expect(index.rows[0]?.indexdef).toContain('WHERE (published_revision_id IS NOT NULL)');
  });

  it('keeps every revision table insert-only: 42501 for the application, 23001 for the owner', async () => {
    const p = await product();
    const f = await familyRevision();
    const v = await variant(p);
    const c = await category();
    const r = await revision(p, f);
    await insert('product_revision_texts', {
      ...base(),
      revision_id: r,
      locale: 'xx',
      name: 'A name',
    });
    await insert('product_revision_categories', {
      ...base(),
      revision_id: r,
      category_id: c,
      position: 0,
    });
    await insert('product_revision_variants', {
      ...base(),
      revision_id: r,
      variant_id: v,
      product_id: p,
      position: 0,
      option_key: 'size=l',
      option_values: '{"size":"l"}',
      labels: '{"xx":"L"}',
    });
    await insert('product_revision_decisions', {
      ...base(),
      revision_id: r,
      outcome: 'changes-requested',
      reason_code: 'needs-photo',
      required_checks: [],
      confirmed_checks: [],
      decided_by_kind: 'admin',
      decided_by_account_id: uuid7(),
      product_version: 1,
      decided_at: T0,
    });
    const tables = [
      'product_revisions',
      'product_revision_texts',
      'product_revision_categories',
      'product_revision_variants',
      'product_revision_decisions',
    ];
    for (const table of tables) {
      expect(
        await sqlState(sql, `UPDATE catalog.${table} SET market_id = market_id WHERE false`),
      ).toBe('42501');
      expect(await sqlState(sql, `DELETE FROM catalog.${table} WHERE false`)).toBe('42501');
      expect(await sqlState(sql, `TRUNCATE catalog.${table} CASCADE`)).toBe('42501');
      expect(
        await sqlState(
          owner,
          `UPDATE catalog.${table} SET market_id = market_id WHERE market_id = $1`,
          [market.marketId],
        ),
      ).toBe('23001');
      expect(
        await sqlState(owner, `DELETE FROM catalog.${table} WHERE market_id = $1`, [
          market.marketId,
        ]),
      ).toBe('23001');
      expect(await sqlState(owner, `TRUNCATE catalog.${table} CASCADE`)).toBe('23001');
    }
    const kept = await sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM catalog.product_revisions WHERE id = $1`,
      [r],
    );
    expect(kept.rows[0]?.n).toBe(1);
  });

  it('refuses a retired variant, a foreign variant and a repeated option key in a revision', async () => {
    const p = await product();
    const q = await product();
    const f = await familyRevision();
    const r = await revision(p, f);
    const row = (variantId: string, overrides: Record<string, unknown> = {}) => ({
      ...base(),
      revision_id: r,
      variant_id: variantId,
      product_id: p,
      position: 0,
      option_key: `size=${randomUUID().slice(0, 6)}`,
      option_values: '{}',
      labels: '{}',
      ...overrides,
    });
    const live = await variant(p, 'proposed');
    const retired = await variant(p, 'proposed');
    await sql.query(
      `UPDATE catalog.product_variants SET state = 'retired', retired_at = $2 WHERE id = $1`,
      [retired, T0],
    );
    const foreign = await variant(q);
    expect(await insertState('product_revision_variants', row(retired))).toBe('23514');
    expect(await insertState('product_revision_variants', row(foreign))).toBe('23503');
    expect(
      await insertState('product_revision_variants', row(live, { option_key: 'size=m' })),
    ).toBeNull();
    const second = await variant(p);
    expect(
      await insertState('product_revision_variants', row(second, { option_key: 'size=m' })),
    ).toBe('23505');
    expect(
      await insertState('product_revision_variants', row(second, { option_values: '[]' })),
    ).toBe('23514');
  });

  it('checks the revision texts and categories', async () => {
    const p = await product();
    const f = await familyRevision();
    const r = await revision(p, f);
    const c = await category();
    const text = (overrides: Record<string, unknown>) =>
      insertState('product_revision_texts', {
        ...base(),
        revision_id: r,
        locale: `x${'x'.repeat(Math.floor(Math.random() * 2))}`,
        name: 'A name',
        ...overrides,
      });
    expect(await text({ locale: 'XX' })).toBe('23514');
    expect(await text({ name: '' })).toBe('23514');
    expect(await text({ name: ' padded ' })).toBe('23514');
    expect(await text({ name: 'line\nbreak' })).toBe('23514');
    expect(await text({ name: 'x'.repeat(201) })).toBe('23514');
    expect(await text({ name: 'bidi‮override' })).toBe('23514');
    expect(await text({ short_description: 'y'.repeat(501) })).toBe('23514');
    expect(await text({ description: 'z'.repeat(10001) })).toBe('23514');
    expect(await text({ locale: 'yy', description: 'two\nlines\tand tab' })).toBeNull();
    expect(await text({ locale: 'yy' })).toBe('23505');

    const cat = (overrides: Record<string, unknown>) =>
      insertState('product_revision_categories', {
        ...base(),
        revision_id: r,
        category_id: c,
        position: 0,
        ...overrides,
      });
    expect(await cat({ position: -1 })).toBe('23514');
    expect(await cat({ category_id: uuid7() })).toBe('23503');
    expect(await cat({})).toBeNull();
    expect(await cat({})).toBe('23505');
  });

  it('checks the decision columns', async () => {
    const p = await product();
    const f = await familyRevision();
    const decision = async (overrides: Record<string, unknown>) =>
      insertState('product_revision_decisions', {
        ...base(),
        revision_id: await revision(p, f, { revision_no: ++sequence + 100 }),
        outcome: 'changes-requested',
        reason_code: 'needs-photo',
        required_checks: [],
        confirmed_checks: [],
        decided_by_kind: 'admin',
        decided_by_account_id: uuid7(),
        product_version: 1,
        decided_at: T0,
        ...overrides,
      });
    const published = { outcome: 'published', reason_code: null, publish_kind: 'reviewed' };
    expect(await decision({ outcome: 'unknown' })).toBe('23514');
    expect(await decision({ reason_code: null })).toBe('23514');
    expect(await decision({ reason_text: 'Fix the name' })).toBeNull();
    expect(await decision({ ...published, reason_text: 'x' })).toBe('23514');
    expect(await decision({ ...published, publish_kind: null })).toBe('23514');
    // D 8.3a: a reviewed publish without every required check cannot be stored.
    expect(
      await decision({ ...published, required_checks: ['a', 'b'], confirmed_checks: ['a'] }),
    ).toBe('23514');
    expect(
      await decision({ ...published, required_checks: ['a'], confirmed_checks: ['a', 'b'] }),
    ).toBeNull();
    // R2: no confirmed checks on an auto-publish; auto needs the setting that was read.
    expect(
      await decision({
        ...published,
        publish_kind: 'auto',
        approval_required_read: false,
        confirmed_checks: ['a'],
        decided_by_kind: 'system',
        decided_by_account_id: null,
      }),
    ).toBe('23514');
    expect(
      await decision({
        ...published,
        publish_kind: 'auto',
        decided_by_kind: 'system',
        decided_by_account_id: null,
      }),
    ).toBe('23514');
    expect(
      await decision({
        ...published,
        publish_kind: 'auto',
        approval_required_read: false,
        decided_by_kind: 'system',
        decided_by_account_id: null,
      }),
    ).toBeNull();
    expect(await decision({ decided_by_kind: 'system' })).toBe('23514');
    expect(
      await decision({
        outcome: 'superseded',
        reason_code: null,
        superseded_cause: 'resubmitted',
        decided_by_kind: 'seller',
      }),
    ).toBeNull();
    expect(
      await decision({ outcome: 'superseded', reason_code: null, superseded_cause: null }),
    ).toBe('23514');
    expect(await decision({ product_version: 0 })).toBe('23514');
    // NULL lists must not slip past the checks rule (R2, H1): B1.
    expect(await decision({ ...published, required_checks: ['a'], confirmed_checks: null })).toBe(
      '23514',
    );
    expect(await decision({ ...published, required_checks: null })).toBe('23514');
    expect(
      await decision({
        ...published,
        publish_kind: 'auto',
        approval_required_read: false,
        confirmed_checks: null,
        decided_by_kind: 'system',
        decided_by_account_id: null,
      }),
    ).toBe('23514');
    expect(await decision({ required_checks: ['Bad Code'] })).toBe('23514');
    expect(await decision({ reason_text: ' padded ' })).toBe('23514');
  });

  it('keeps the working copy mutable and deletable by the application', async () => {
    const p = await product();
    const f = await familyRevision();
    const r = await revision(p, f);
    const copy = {
      ...base(),
      product_id: p,
      content: '{"texts":{}}',
      content_schema_version: 1,
      base_revision_id: null,
      last_saved_at: T0,
      last_saved_by_account_id: uuid7(),
    };
    expect(await insertState('product_working_copies', { ...copy, content: '[]' })).toBe('23514');
    expect(
      await insertState('product_working_copies', { ...copy, content_schema_version: 0 }),
    ).toBe('23514');
    expect(
      await insertState('product_working_copies', { ...copy, base_revision_id: uuid7() }),
    ).toBe('23503');
    expect(await insertState('product_working_copies', copy)).toBeNull();
    expect(await insertState('product_working_copies', copy)).toBe('23505');
    expect(
      await sqlState(
        sql,
        `UPDATE catalog.product_working_copies SET base_revision_id = $2, last_saved_at = $3 WHERE product_id = $1`,
        [p, r, '2026-10-08T01:00:00Z'],
      ),
    ).toBeNull();
    // The range the prune job reads (A22) has its index.
    const index = await sql.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'catalog' AND indexname = 'product_working_copies_market_id_last_saved_at_idx'`,
    );
    expect(index.rowCount).toBe(1);
    expect(
      await sqlState(sql, `DELETE FROM catalog.product_working_copies WHERE product_id = $1`, [p]),
    ).toBeNull();
    // A product row itself is never deleted (Q-K2).
    expect(await sqlState(sql, `DELETE FROM catalog.products WHERE id = $1`, [p])).toBe('42501');
  });

  it('checks the rate counters and lets the application purge them', async () => {
    const counter = (overrides: Record<string, unknown>) =>
      insertState('rate_counters', {
        ...base(),
        kind: 'draft-save.account.minute',
        key_hash: Buffer.alloc(32, Math.floor(Math.random() * 255)),
        window_started_at: T0,
        count: 1,
        ...overrides,
      });
    expect(await counter({ kind: 'unknown.kind' })).toBe('23514');
    expect(await counter({ key_hash: Buffer.alloc(31) })).toBe('23514');
    expect(await counter({ count: -1 })).toBe('23514');
    const hash = Buffer.alloc(32, 7);
    for (const kind of [
      'draft-save.account.day',
      'claim-text-check.account.minute',
      'submit.seller.hour',
    ]) {
      expect(await counter({ kind, key_hash: hash })).toBeNull();
    }
    expect(
      await sqlState(
        sql,
        `DELETE FROM catalog.rate_counters WHERE market_id = $1 AND key_hash = $2`,
        [market.marketId, hash],
      ),
    ).toBeNull();
  });
});
