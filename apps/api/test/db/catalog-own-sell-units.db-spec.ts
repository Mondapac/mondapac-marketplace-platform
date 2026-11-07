import { randomUUID } from 'node:crypto';
import type { Id } from '@mondapac/shared-kernel';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaOwnCatalogReader } from '../../src/modules/catalog/infrastructure/prisma-own-catalog.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// `sellUnitsOf`, the read behind the seller's Offer view (variants V5), on PostgreSQL for both
// Market fixtures: only the rows of the asked Offer come back, with the SKU null in one row and
// set in the other; an Offer of another seller on the same product and an Offer of another Market
// add nothing.

const T0 = '2026-11-05T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sku = (): string => `SKU-${randomUUID().slice(0, 13)}`;

describe.each(TEST_MARKETS)('catalog own sell-unit read in market %s (database)', (code) => {
  const market = marketOf(code);
  const otherMarket = marketOf(otherMarketOf(code));
  let sql: Client;
  let persistence: Persistence;
  let reader: PrismaOwnCatalogReader;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    persistence = createPersistence();
    reader = new PrismaOwnCatalogReader(persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });

  async function insert(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns
        .map((_, i) => `$${i + 1}`)
        .join(', ')})`,
      Object.values(row),
    );
  }
  const base = (m: typeof market) => ({ market_id: m.marketId, tenant_id: m.tenantId });

  async function product(m: typeof market): Promise<string> {
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
  async function variant(productId: string, no: number, m: typeof market): Promise<string> {
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
  async function offer(productId: string, sellerId: string, m: typeof market): Promise<string> {
    const id = uuid7();
    await insert('offers', {
      id,
      ...base(m),
      seller_id: sellerId,
      product_id: productId,
      seller_sku: sku(),
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
  async function unit(
    m: typeof market,
    offerId: string,
    sellerId: string,
    productId: string,
    variantId: string,
    overrides: Record<string, unknown> = {},
  ) {
    await insert('offer_sell_units', {
      id: uuid7(),
      ...base(m),
      offer_id: offerId,
      seller_id: sellerId,
      product_id: productId,
      variant_id: variantId,
      variant_sku: null,
      selling: true,
      version: 1,
      created_at: T0,
      updated_at: T0,
      ...overrides,
    });
  }
  const read = (m: typeof market, offerId: string) =>
    persistence.unitOfWork
      .run(
        m,
        async () => ({
          ok: true as const,
          value: await reader.sellUnitsOf(m, offerId as Id<'Offer'>),
        }),
        { readOnly: true },
      )
      .then((result) => {
        if (!result.ok) throw new Error('unit failed');
        return result.value;
      });

  it('returns only the rows of the asked Offer, SKU null in one and set in the other', async () => {
    const seller = uuid7();
    const rival = uuid7();
    const p = await product(market);
    const v1 = await variant(p, 1, market);
    const v2 = await variant(p, 2, market);
    const v3 = await variant(p, 3, market);
    const mine = await offer(p, seller, market);
    const theirs = await offer(p, rival, market);
    const set = sku();
    await unit(market, mine, seller, p, v1, { variant_sku: set });
    await unit(market, mine, seller, p, v2, { selling: false });
    await unit(market, theirs, rival, p, v1, { variant_sku: sku() });
    await unit(market, theirs, rival, p, v3);

    const rows = await read(market, mine);
    expect([...rows].sort((a, b) => a.variantId.localeCompare(b.variantId))).toEqual(
      [
        { variantId: v1, variantSku: set, selling: true },
        { variantId: v2, variantSku: null, selling: false },
      ].sort((a, b) => a.variantId.localeCompare(b.variantId)),
    );
    expect((await read(market, theirs)).map((row) => row.variantId).sort()).toEqual(
      [v1, v3].sort(),
    );
  });

  it('returns nothing for an Offer with no stored row and for an Offer of another Market', async () => {
    const seller = uuid7();
    const p = await product(market);
    await variant(p, 1, market);
    const bare = await offer(p, seller, market);
    expect(await read(market, bare)).toEqual([]);

    const op = await product(otherMarket);
    const ov = await variant(op, 1, otherMarket);
    const foreign = await offer(op, seller, otherMarket);
    await unit(otherMarket, foreign, seller, op, ov, { variant_sku: sku() });
    expect(await read(market, foreign)).toEqual([]);
    expect(await read(otherMarket, foreign)).toHaveLength(1);
  });
});
