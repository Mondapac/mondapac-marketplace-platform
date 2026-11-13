import { randomUUID } from 'node:crypto';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';
import { sqlState } from './sql-state';

// Variants V7 on PostgreSQL (migration 20261113020000_catalog_variant_requests), for both Market
// fixtures, as the API role: the request must sit on an Offer that sells a PLATFORM product, one
// open request per Offer and combination, the decision's shape, the guard (immutable columns,
// one move out of open, a notice moves only out of pending), the same-seller, same-product and
// same-Market foreign keys, and the grants (no DELETE).

const T0 = '2026-11-05T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog variant requests in market %s (database)', (code) => {
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

  async function product(scope: 'PLATFORM' | 'SELLER' = 'PLATFORM', seller?: string, m = market) {
    const id = uuid7();
    await insert('products', {
      id,
      ...base(m),
      scope,
      owner_seller_id: scope === 'SELLER' ? seller : null,
      created_by_seller_id: scope === 'SELLER' ? seller : null,
      type_code: 'configurable',
      variant_model: 'options',
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
  async function variant(productId: string, no: number, m = market) {
    const id = uuid7();
    await insert('product_variants', {
      id,
      ...base(m),
      product_id: productId,
      variant_model: 'options',
      variant_no: no,
      state: 'proposed',
      created_at: T0,
      published_at: null,
    });
    return id;
  }
  async function offer(productId: string, sellerId: string, m = market) {
    const id = uuid7();
    await insert('offers', {
      id,
      ...base(m),
      seller_id: sellerId,
      product_id: productId,
      seller_sku: `SKU-${randomUUID().slice(0, 13)}`,
      condition_code: 'new',
      description: '{}',
      handling: null,
      status: 'draft',
      off_sale_type_not_allowed: false,
      off_sale_product_retired: false,
      off_sale_product_not_listed: false,
      off_sale_tag_suspended: false,
      off_sale_product_paused: false,
      off_sale_description_claim_text: false,
      listed: false,
      version: 1,
      created_at: T0,
    });
    return id;
  }
  const requestRow = (
    offerId: string,
    sellerId: string,
    productId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: uuid7(),
    ...base(),
    seller_id: sellerId,
    offer_id: offerId,
    product_id: productId,
    option_values: JSON.stringify({ size: 'xl' }),
    option_key: 'size=xl',
    status: 'open',
    resolved_variant_id: null,
    decline_reason: null,
    decided_by_account_id: null,
    decided_at: null,
    notice_state: 'none',
    notice_attempts: 0,
    notice_next_attempt_at: null,
    version: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  });
  const decideSql = `UPDATE catalog.variant_requests SET status = $3, resolved_variant_id = $4,
    decline_reason = $5, decided_by_account_id = $6, decided_at = now(), notice_state = 'pending',
    notice_attempts = 0, notice_next_attempt_at = now(), version = 2
    WHERE market_id = $1 AND id = $2`;

  /** A seller with an Offer on a PLATFORM product that has two variants, and one open request. */
  async function scene() {
    const seller = uuid7();
    const p = await product();
    const v1 = await variant(p, 1);
    const o = await offer(p, seller);
    const row = requestRow(o, seller, p);
    await insert('variant_requests', row);
    return { seller, p, v1, o, row };
  }

  it('stores an open request on an Offer of a PLATFORM product', async () => {
    const { row } = await scene();
    const read = await sql.query(
      'SELECT status, version, notice_state FROM catalog.variant_requests WHERE market_id = $1 AND id = $2',
      [market.marketId, row.id],
    );
    expect(read.rows).toEqual([{ status: 'open', version: 1, notice_state: 'none' }]);
  });

  it('refuses a request on an Offer of a SELLER product', async () => {
    const seller = uuid7();
    const p = await product('SELLER', seller);
    const o = await offer(p, seller);
    expect(await insertState('variant_requests', requestRow(o, seller, p))).toBe('23514');
  });

  it('refuses another seller’s Offer, another product and an Offer of another Market', async () => {
    const { seller, p, o } = await scene();
    expect(
      await insertState('variant_requests', requestRow(o, uuid7(), p, { option_key: 'z=z' })),
    ).toBe('23503');
    const elsewhere = await product();
    expect(
      await insertState(
        'variant_requests',
        requestRow(o, seller, elsewhere, { option_key: 'a=b' }),
      ),
    ).toBe('23514');
    const foreign = other;
    const fp = await product('PLATFORM', undefined, foreign);
    const fo = await offer(fp, seller, foreign);
    expect(
      await insertState('variant_requests', requestRow(fo, seller, fp, { option_key: 'y=y' })),
    ).toBe('23514');
  });

  it('allows one open request per Offer and combination, and a new one once it is decided', async () => {
    const { seller, p, o, row } = await scene();
    expect(
      await insertState('variant_requests', requestRow(o, seller, p, { option_key: 'size=xl' })),
    ).toBe('23505');
    expect(
      await insertState('variant_requests', requestRow(o, seller, p, { option_key: 'size=s' })),
    ).toBeNull();
    await sql.query(decideSql, [market.marketId, row.id, 'declined', null, 'No', uuid7()]);
    expect(
      await insertState('variant_requests', requestRow(o, seller, p, { option_key: 'size=xl' })),
    ).toBeNull();
  });

  it('refuses a request that is not born open at version 1, and bad option values', async () => {
    const { seller, p, o } = await scene();
    const fresh = (overrides: Record<string, unknown>) =>
      requestRow(o, seller, p, { option_key: `k=${uuid7().slice(-8)}`, ...overrides });
    expect(await insertState('variant_requests', fresh({ version: 2 }))).toBe('23514');
    expect(await insertState('variant_requests', fresh({ option_values: '{}' }))).toBe('23514');
    expect(await insertState('variant_requests', fresh({ option_values: '["a"]' }))).toBe('23514');
    expect(await insertState('variant_requests', fresh({ status: 'declined' }))).toBe('23514');
  });

  it('decides once, with the shape of each decision', async () => {
    const { p, v1, row } = await scene();
    const admin = uuid7();
    const decide = (status: string, variantId: string | null, reason: string | null) =>
      sqlState(sql, decideSql, [market.marketId, row.id, status, variantId, reason, admin]);
    expect(await decide('approved', null, null)).toBe('23514');
    expect(await decide('declined', null, null)).toBe('23514');
    expect(await decide('declined', null, '  padded ')).toBe('23514');
    expect(await decide('mapped', uuid7(), null)).toBe('23503');
    const elsewhere = await variant(await product(), 1);
    expect(await decide('mapped', elsewhere, null)).toBe('23503');
    expect(await decide('mapped', v1, null)).toBeNull();
    expect(p).toBeTruthy();
    expect(await decide('declined', null, 'No')).toBe('23001');
  });

  it('moves the notice only out of pending, and never changes a decision', async () => {
    const { row } = await scene();
    await sql.query(decideSql, [market.marketId, row.id, 'declined', null, 'No', uuid7()]);
    const mark = (state: string, version: number) =>
      sqlState(
        sql,
        `UPDATE catalog.variant_requests SET notice_state = $3, notice_next_attempt_at = NULL,
           notice_attempts = 1, version = $4 WHERE market_id = $1 AND id = $2`,
        [market.marketId, row.id, state, version],
      );
    expect(await mark('sent', 5)).toBe('23001');
    expect(await mark('sent', 3)).toBeNull();
    expect(await mark('failed', 4)).toBe('23001');
    expect(
      await sqlState(
        sql,
        `UPDATE catalog.variant_requests SET decline_reason = 'Other', version = 4 WHERE market_id = $1 AND id = $2`,
        [market.marketId, row.id],
      ),
    ).toBe('23001');
  });

  it('refuses a change of the owning columns, a delete and a truncate', async () => {
    const { row } = await scene();
    expect(
      await sqlState(
        sql,
        `UPDATE catalog.variant_requests SET option_key = 'size=s', version = 2 WHERE market_id = $1 AND id = $2`,
        [market.marketId, row.id],
      ),
    ).toMatch(/42501|23001/);
    expect(
      await sqlState(sql, 'DELETE FROM catalog.variant_requests WHERE market_id = $1 AND id = $2', [
        market.marketId,
        row.id,
      ]),
    ).toBe('42501');
    expect(await sqlState(owner, 'TRUNCATE catalog.variant_requests')).toBe('23001');
  });
});
