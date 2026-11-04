import { randomUUID } from 'node:crypto';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';
import { sqlState } from './sql-state';

// Variants V5 on PostgreSQL (migration 20261105000000_catalog_offer_sell_units), for both Market
// fixtures: the sparse (Offer, Variant) row, the SKU shape and per-seller unique, the two-way
// check against Offer SKUs (triggers), the same-seller and same-Market foreign keys, and the
// grants (no DELETE, no change of the owning columns).

const T0 = '2026-11-05T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sku = (): string => `SKU-${randomUUID().slice(0, 13)}`;

describe.each(TEST_MARKETS)(
  'catalog offer sell units in market %s (database integration)',
  (code) => {
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
    async function variant(productId: string, no: number, m = market): Promise<string> {
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
    const offerRow = (productId: string, sellerId: string, sellerSku: string) => ({
      id: uuid7(),
      ...base(),
      seller_id: sellerId,
      product_id: productId,
      seller_sku: sellerSku,
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
    async function offer(productId: string, sellerId: string, sellerSku = sku()) {
      const row = offerRow(productId, sellerId, sellerSku);
      await insert('offers', row);
      return row.id;
    }
    const unitRow = (
      offerId: string,
      sellerId: string,
      variantId: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: uuid7(),
      ...base(),
      offer_id: offerId,
      seller_id: sellerId,
      variant_id: variantId,
      variant_sku: null,
      selling: true,
      version: 1,
      created_at: T0,
      updated_at: T0,
      ...overrides,
    });

    it('stores a row per (Offer, Variant) and refuses a second one', async () => {
      const seller = uuid7();
      const p = await product();
      const v = await variant(p, 1);
      const o = await offer(p, seller);
      await insert('offer_sell_units', unitRow(o, seller, v, { selling: false }));
      expect(await insertState('offer_sell_units', unitRow(o, seller, v))).toBe('23505');
    });

    it('refuses a malformed SKU and a zero version', async () => {
      const seller = uuid7();
      const p = await product();
      const v = await variant(p, 1);
      const o = await offer(p, seller);
      for (const bad of ['', 'has space', 'x'.repeat(65), 'é']) {
        expect(
          await insertState('offer_sell_units', unitRow(o, seller, v, { variant_sku: bad })),
        ).toBe('23514');
      }
      expect(await insertState('offer_sell_units', unitRow(o, seller, v, { version: 0 }))).toBe(
        '23514',
      );
    });

    it('keeps a variant SKU unique per seller, not across sellers', async () => {
      const seller = uuid7();
      const p = await product();
      const v1 = await variant(p, 1);
      const v2 = await variant(p, 2);
      const o = await offer(p, seller);
      const same = sku();
      await insert('offer_sell_units', unitRow(o, seller, v1, { variant_sku: same }));
      expect(
        await insertState('offer_sell_units', unitRow(o, seller, v2, { variant_sku: same })),
      ).toBe('23505');
      const seller2 = uuid7();
      const o2 = await offer(p, seller2);
      await insert('offer_sell_units', unitRow(o2, seller2, v1, { variant_sku: same }));
    });

    it('refuses a variant SKU equal to an open Offer SKU of the seller, in both directions', async () => {
      const seller = uuid7();
      const p = await product();
      const p2 = await product();
      const v = await variant(p, 1);
      const offerSku = sku();
      const o = await offer(p, seller, offerSku);
      const o2 = await offer(p2, seller);
      const v2 = await variant(p2, 1);
      expect(
        await insertState('offer_sell_units', unitRow(o2, seller, v2, { variant_sku: offerSku })),
      ).toBe('23505');
      // The other direction: a unit SKU exists, then an Offer of the same seller takes it.
      const unitSku = sku();
      await insert('offer_sell_units', unitRow(o, seller, v, { variant_sku: unitSku }));
      const p3 = await product();
      expect(await insertState('offers', offerRow(p3, seller, unitSku))).toBe('23505');
      // Another seller's Offer may use it.
      await insert('offers', offerRow(p3, uuid7(), unitSku));
    });

    it('refuses a row whose seller is not the Offer’s seller', async () => {
      const seller = uuid7();
      const p = await product();
      const v = await variant(p, 1);
      const o = await offer(p, seller);
      expect(await insertState('offer_sell_units', unitRow(o, uuid7(), v))).toBe('23503');
    });

    it('refuses a variant of another Market', async () => {
      const seller = uuid7();
      const p = await product();
      const o = await offer(p, seller);
      const po = await product(other);
      const vo = await variant(po, 1, other);
      expect(await insertState('offer_sell_units', unitRow(o, seller, vo))).toBe('23503');
    });

    it('lets the application switch and re-SKU a row but never delete it or move its owner', async () => {
      const seller = uuid7();
      const p = await product();
      const v = await variant(p, 1);
      const o = await offer(p, seller);
      const row = unitRow(o, seller, v);
      await insert('offer_sell_units', row);
      await sql.query(
        `UPDATE catalog.offer_sell_units SET selling = false, variant_sku = $3, version = 2, updated_at = $4
          WHERE market_id = $1 AND offer_id = $2`,
        [market.marketId, o, sku(), T0],
      );
      expect(
        await sqlState(sql, `UPDATE catalog.offer_sell_units SET seller_id = $2 WHERE id = $1`, [
          row.id,
          uuid7(),
        ]),
      ).toBe('42501');
      expect(
        await sqlState(sql, `DELETE FROM catalog.offer_sell_units WHERE id = $1`, [row.id]),
      ).toBe('42501');
      expect(owner).toBeDefined();
    });
  },
);
