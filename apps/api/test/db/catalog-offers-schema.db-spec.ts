import { randomUUID } from 'node:crypto';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';
import { sqlState } from './sql-state';

// Catalog slice 7 on PostgreSQL (catalog data design 3.13, 3.14, 5.1, 7; migration
// 20261009030000_catalog_offers), for both Market fixtures: every CHECK, unique, foreign key and
// grant of `offers` and `offer_history`, the insert-only history, and Market independence. Raw
// SQL on the application and owner connections.

const T0 = '2026-10-09T00:00:00Z';
const T1 = '2026-10-09T01:00:00Z';
const CAUSES = [
  'off_sale_type_not_allowed',
  'off_sale_product_retired',
  'off_sale_product_not_listed',
  'off_sale_tag_suspended',
  'off_sale_description_claim_text',
] as const;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sku = (): string => `SKU-${randomUUID().slice(0, 13)}`;

describe.each(TEST_MARKETS)('catalog offers schema in market %s (database integration)', (code) => {
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

  const insertSql = (table: string, row: Record<string, unknown>) =>
    `INSERT INTO catalog.${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(', ')})`;
  async function insert(table: string, row: Record<string, unknown>) {
    await sql.query(insertSql(table, row), Object.values(row));
  }
  const insertState = (table: string, row: Record<string, unknown>) =>
    sqlState(sql, insertSql(table, row), Object.values(row));

  const base = (m = market) => ({ market_id: m.marketId, tenant_id: m.tenantId });

  async function product(m = market): Promise<string> {
    const id = uuid7();
    await insert('products', {
      id,
      ...base(m),
      scope: 'PLATFORM',
      owner_seller_id: null,
      created_by_seller_id: null,
      type_code: 'simple',
      variant_model: 'single',
      family_code: 'default',
      product_code: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      status: 'draft',
      own_brand: false,
      last_changed_at: T0,
      version: 1,
      created_at: T0,
    });
    return id;
  }

  function offerRow(productId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: uuid7(),
      ...base(),
      seller_id: uuid7(),
      product_id: productId,
      seller_sku: sku(),
      condition_code: 'new',
      description: '{"en-AU":"A description"}',
      handling: null,
      attestation_recorded_at: null,
      attestation_account_id: null,
      status: 'draft',
      off_sale_type_not_allowed: false,
      off_sale_product_retired: false,
      off_sale_product_not_listed: false,
      off_sale_tag_suspended: false,
      off_sale_description_claim_text: false,
      listed: false,
      submitted_at: null,
      first_published_at: null,
      deleted_at: null,
      version: 1,
      created_at: T0,
      ...overrides,
    };
  }

  const published = {
    status: 'published',
    handling: 'SEALED_ORIGINAL',
    listed: true,
    submitted_at: T0,
    first_published_at: T0,
  };

  async function offer(productId: string, overrides: Record<string, unknown> = {}) {
    const row = offerRow(productId, overrides);
    await insert('offers', row);
    return row;
  }

  function historyRow(offerId: string, productId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: uuid7(),
      ...base(),
      offer_id: offerId,
      offer_version: 1,
      change_kind: 'created',
      changed_fields: [],
      product_id: productId,
      status: 'draft',
      seller_sku: 'SKU-1',
      condition_code: 'new',
      description: '{"en-AU":"A description"}',
      handling: null,
      attestation_recorded: false,
      shelf_category_id: null,
      listed: false,
      off_sale_causes: [],
      actor_kind: 'seller',
      actor_account_id: uuid7(),
      acting_admin_account_id: null,
      occurred_at: T0,
      ...overrides,
    };
  }

  it('checks the Offer columns', async () => {
    const p = await product();
    const bad = (overrides: Record<string, unknown>) =>
      insertState('offers', offerRow(p, overrides));
    expect(await bad({ market_id: 'au' })).toBe('23514');
    expect(await bad({ tenant_id: 'Default' })).toBe('23514');
    // SKU: 1 to 64 printable ASCII characters, no space or control character.
    expect(await bad({ seller_sku: '' })).toBe('23514');
    expect(await bad({ seller_sku: 'A'.repeat(65) })).toBe('23514');
    expect(await bad({ seller_sku: 'has space' })).toBe('23514');
    expect(await bad({ seller_sku: 'tab\t1' })).toBe('23514');
    expect(await bad({ seller_sku: 'ÄBC' })).toBe('23514');
    expect(await bad({ condition_code: 'New' })).toBe('23514');
    expect(await bad({ description: '[]' })).toBe('23514');
    expect(await bad({ description: '"text"' })).toBe('23514');
    expect(await bad({ handling: 'sealed_original' })).toBe('23514');
    expect(await bad({ status: 'pending' })).toBe('23514');
    expect(await bad({ version: 0 })).toBe('23514');
    // Attestation: both or neither.
    expect(await bad({ attestation_recorded_at: T0 })).toBe('23514');
    expect(await bad({ attestation_account_id: uuid7() })).toBe('23514');
    // Handling is required from the submit on (D 4.4).
    for (const status of ['pending-first-publish', 'changes-needed', 'published']) {
      expect(
        await bad({ ...published, status, listed: status === 'published', handling: null }),
      ).toBe('23514');
    }
    // A pending Offer has its submit instant; a published one its first publication.
    expect(await bad({ status: 'pending-first-publish', handling: 'FRESH' })).toBe('23514');
    expect(await bad({ ...published, first_published_at: null })).toBe('23514');
    // deleted exactly when deleted_at is set.
    expect(await bad({ status: 'deleted' })).toBe('23514');
    expect(await bad({ deleted_at: T1 })).toBe('23514');

    expect(await bad({ seller_sku: '!~A-z_0.9/#' })).toBeNull();
    expect(await bad({ seller_sku: 'A'.repeat(64) })).toBeNull();
    expect(await bad({ attestation_recorded_at: T0, attestation_account_id: uuid7() })).toBeNull();
    expect(await bad({ status: 'deleted', deleted_at: T1 })).toBeNull();
    for (const handling of ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH']) {
      expect(await bad({ status: 'pending-first-publish', handling, submitted_at: T0 })).toBeNull();
    }
    expect(await bad({ status: 'changes-needed', handling: 'REPACKED' })).toBeNull();
    expect(await bad({ handling: 'PREPARED' })).toBeNull();
    expect(await bad(published)).toBeNull();
  });

  it('holds listed to "published and no off-sale cause" (offers_listed_check)', async () => {
    const p = await product();
    const bad = (overrides: Record<string, unknown>) =>
      insertState('offers', offerRow(p, overrides));
    expect(await bad({ listed: true })).toBe('23514');
    expect(await bad({ ...published, listed: false })).toBe('23514');
    for (const cause of CAUSES) {
      expect(await bad({ ...published, [cause]: true })).toBe('23514');
      expect(await bad({ ...published, [cause]: true, listed: false })).toBeNull();
    }
    // A cause on a draft is allowed and keeps it unlisted.
    expect(await bad({ off_sale_type_not_allowed: true })).toBeNull();

    // The same rule holds on UPDATE (a cause added without clearing listed fails).
    const row = await offer(p, published);
    const update = (set: string) =>
      sqlState(sql, `UPDATE catalog.offers SET ${set} WHERE id = $1`, [row.id]);
    expect(await update('off_sale_tag_suspended = true')).toBe('23514');
    expect(await update('off_sale_tag_suspended = true, listed = false, version = 2')).toBeNull();
    expect(await update('off_sale_tag_suspended = false')).toBe('23514');
    expect(await update('off_sale_tag_suspended = false, listed = true, version = 3')).toBeNull();
  });

  it('keeps one non-deleted Offer per (Market, seller, product) and per (Market, seller, SKU)', async () => {
    const p = await product();
    const q = await product();
    const seller = uuid7();
    const first = await offer(p, { seller_id: seller, seller_sku: 'ABC-1' });
    // The same product again for the same seller, a draft included (OFR-02, AC 2).
    expect(
      await insertState('offers', offerRow(p, { seller_id: seller, seller_sku: 'ABC-2' })),
    ).toBe('23505');
    // The same SKU on another product of the same seller (CAT-10).
    expect(
      await insertState('offers', offerRow(q, { seller_id: seller, seller_sku: 'ABC-1' })),
    ).toBe('23505');
    // The SKU compares case-sensitively (collation "C").
    expect(
      await insertState('offers', offerRow(q, { seller_id: seller, seller_sku: 'abc-1' })),
    ).toBeNull();
    // Another seller may sell the same product under the same SKU.
    expect(await insertState('offers', offerRow(p, { seller_sku: 'ABC-1' }))).toBeNull();
    // Once deleted, the product and the SKU are free for a new Offer; the deleted row stays.
    expect(
      await sqlState(
        sql,
        `UPDATE catalog.offers SET status = 'deleted', deleted_at = $2, version = 2 WHERE id = $1`,
        [first.id, T1],
      ),
    ).toBeNull();
    expect(
      await insertState('offers', offerRow(p, { seller_id: seller, seller_sku: 'ABC-1' })),
    ).toBeNull();
    const rows = await sql.query<{ status: string }>(
      `SELECT status FROM catalog.offers WHERE market_id = $1 AND seller_id = $2 AND product_id = $3 ORDER BY status`,
      [market.marketId, seller, p],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['deleted', 'draft']);
    // A deleted row cannot come back while a new open Offer exists.
    expect(
      await sqlState(
        sql,
        `UPDATE catalog.offers SET status = 'draft', deleted_at = NULL, version = 3 WHERE id = $1`,
        [first.id],
      ),
    ).toBe('23505');
    // The id is unique on its own, and so the composite FK targets are too.
    expect(await insertState('offers', offerRow(q, { id: first.id }))).toBe('23505');
  });

  it('binds an Offer to a product of its own Market; the two Markets are independent', async () => {
    const p = await product();
    const pOther = await product(other);
    expect(await insertState('offers', offerRow(uuid7()))).toBe('23503');
    // A child row in the other Market (PM6).
    expect(await insertState('offers', offerRow(p, base(other)))).toBe('23503');
    // One seller id and one SKU in both Markets: no unique crosses a Market.
    const seller = uuid7();
    expect(
      await insertState('offers', offerRow(p, { seller_id: seller, seller_sku: 'SAME-SKU' })),
    ).toBeNull();
    expect(
      await insertState(
        'offers',
        offerRow(pOther, { ...base(other), seller_id: seller, seller_sku: 'SAME-SKU' }),
      ),
    ).toBeNull();
    // A move (CAT-45) to a product of the other Market fails.
    expect(
      await sqlState(
        sql,
        `UPDATE catalog.offers SET product_id = $2 WHERE market_id = $1 AND seller_id = $3`,
        [market.marketId, pOther, seller],
      ),
    ).toBe('23503');
    // A product with an Offer is never deleted (no grant; Q-K2), nor its id changed.
    expect(await sqlState(owner, `DELETE FROM catalog.products WHERE id = $1`, [p])).toBe('23503');
  });

  it('grants the application no DELETE and no UPDATE of the seller or identity columns', async () => {
    const p = await product();
    const q = await product();
    const row = await offer(p);
    const update = (set: string, values: unknown[] = []) =>
      sqlState(sql, `UPDATE catalog.offers SET ${set} WHERE id = $1`, [row.id, ...values]);
    expect(await update('seller_id = $2', [uuid7()])).toBe('42501');
    expect(await update('id = $2', [uuid7()])).toBe('42501');
    expect(await update('market_id = market_id')).toBe('42501');
    expect(await update('tenant_id = tenant_id')).toBe('42501');
    expect(await update('created_at = $2', [T1])).toBe('42501');
    expect(await sqlState(sql, `DELETE FROM catalog.offers WHERE id = $1`, [row.id])).toBe('42501');
    expect(await sqlState(sql, `TRUNCATE catalog.offers CASCADE`)).toBe('42501');
    // Every granted column can be written (the column list of section 7).
    expect(
      await update(
        `product_id = $2, seller_sku = $3, condition_code = 'used', description = '{"en-AU":"B"}',
         handling = 'REPACKED', attestation_recorded_at = $4, attestation_account_id = $5,
         status = 'pending-first-publish', submitted_at = $4, version = 2`,
        [q, sku(), T1, uuid7()],
      ),
    ).toBeNull();
    expect(
      await update(
        `status = 'published', listed = true, first_published_at = $2, version = 3,
         off_sale_type_not_allowed = false, off_sale_product_retired = false,
         off_sale_product_not_listed = false, off_sale_tag_suspended = false,
         off_sale_description_claim_text = false`,
        [T1],
      ),
    ).toBeNull();
    expect(
      await update(`status = 'deleted', listed = false, deleted_at = $2, version = 4`, [T1]),
    ).toBeNull();
    const kept = await sql.query<{ seller_id: string }>(
      `SELECT seller_id FROM catalog.offers WHERE id = $1`,
      [row.id],
    );
    expect(kept.rows[0]?.seller_id).toBe(row.seller_id);
  });

  it('checks the Offer history columns', async () => {
    const p = await product();
    const o = await offer(p);
    const bad = (overrides: Record<string, unknown>) =>
      insertState('offer_history', historyRow(o.id, p, overrides));
    expect(await bad({ market_id: 'au' })).toBe('23514');
    expect(await bad({ tenant_id: 'Default' })).toBe('23514');
    expect(await bad({ offer_version: 0 })).toBe('23514');
    expect(await bad({ change_kind: 'renamed' })).toBe('23514');
    expect(await bad({ changed_fields: null })).toBe('23514');
    expect(await bad({ changed_fields: ['description', null] })).toBe('23514');
    expect(await bad({ changed_fields: ['Bad Field'] })).toBe('23514');
    expect(await bad({ status: 'pending' })).toBe('23514');
    expect(await bad({ seller_sku: 'has space' })).toBe('23514');
    expect(await bad({ condition_code: 'New' })).toBe('23514');
    expect(await bad({ description: '[]' })).toBe('23514');
    expect(await bad({ handling: 'fresh' })).toBe('23514');
    expect(await bad({ status: 'published', listed: true, handling: null })).toBe('23514');
    expect(await bad({ off_sale_causes: null })).toBe('23514');
    expect(await bad({ off_sale_causes: ['price-missing'] })).toBe('23514');
    expect(await bad({ off_sale_causes: [null] })).toBe('23514');
    expect(await bad({ listed: true })).toBe('23514');
    expect(
      await bad({
        status: 'published',
        handling: 'FRESH',
        listed: true,
        off_sale_causes: ['tag-suspended'],
      }),
    ).toBe('23514');
    expect(await bad({ status: 'published', handling: 'FRESH', listed: false })).toBe('23514');
    expect(await bad({ actor_kind: 'bot' })).toBe('23514');
    expect(await bad({ actor_kind: 'system' })).toBe('23514');
    expect(await bad({ actor_account_id: null })).toBe('23514');
    expect(await bad({ actor_kind: 'admin', acting_admin_account_id: uuid7() })).toBe('23514');

    let version = 1;
    const good = (overrides: Record<string, unknown>) =>
      bad({ offer_version: version++, ...overrides });
    expect(await good({})).toBeNull();
    for (const changeKind of [
      'edited',
      'submitted',
      'publication-approved',
      'changes-requested',
      'published',
      'handling-changed',
      'attestation-recorded',
      'attestation-withdrawn',
      'causes-changed',
      'moved',
      'shelf-cleared',
      'deleted',
    ]) {
      expect(await good({ change_kind: changeKind, changed_fields: ['description'] })).toBeNull();
    }
    expect(
      await good({
        status: 'published',
        handling: 'SEALED_ORIGINAL',
        listed: false,
        attestation_recorded: true,
        changed_fields: ['sellerSku', 'conditionCode'],
        off_sale_causes: [
          'type-not-allowed',
          'product-retired',
          'product-not-listed',
          'tag-suspended',
          'description-claim-text',
        ],
      }),
    ).toBeNull();
    expect(
      await good({ status: 'published', handling: 'FRESH', listed: true, actor_kind: 'admin' }),
    ).toBeNull();
    expect(await good({ actor_kind: 'system', actor_account_id: null })).toBeNull();
    expect(await good({ acting_admin_account_id: uuid7() })).toBeNull();
    // One row per Offer version.
    expect(await bad({ offer_version: 1 })).toBe('23505');
  });

  it('binds a history row to an Offer of its own Market', async () => {
    const p = await product();
    const o = await offer(p);
    expect(await insertState('offer_history', historyRow(uuid7(), p))).toBe('23503');
    expect(await insertState('offer_history', historyRow(o.id, p, base(other)))).toBe('23503');
  });

  it('keeps the Offer history insert-only: 42501 for the application, 23001 for the owner', async () => {
    const p = await product();
    const o = await offer(p);
    const row = historyRow(o.id, p);
    await insert('offer_history', row);

    expect(
      await sqlState(sql, `UPDATE catalog.offer_history SET market_id = market_id WHERE false`),
    ).toBe('42501');
    expect(await sqlState(sql, `DELETE FROM catalog.offer_history WHERE false`)).toBe('42501');
    expect(await sqlState(sql, `TRUNCATE catalog.offer_history CASCADE`)).toBe('42501');
    expect(
      await sqlState(owner, `UPDATE catalog.offer_history SET listed = listed WHERE id = $1`, [
        row.id,
      ]),
    ).toBe('23001');
    expect(await sqlState(owner, `DELETE FROM catalog.offer_history WHERE id = $1`, [row.id])).toBe(
      '23001',
    );
    expect(await sqlState(owner, `TRUNCATE catalog.offer_history CASCADE`)).toBe('23001');
    const kept = await sql.query<{ change_kind: string; offer_version: number }>(
      `SELECT change_kind, offer_version FROM catalog.offer_history WHERE id = $1`,
      [row.id],
    );
    expect(kept.rows).toEqual([{ change_kind: 'created', offer_version: 1 }]);
    // An Offer with history is never removed, even by the owner.
    expect(await sqlState(owner, `DELETE FROM catalog.offers WHERE id = $1`, [o.id])).toBe('23503');
  });
});
