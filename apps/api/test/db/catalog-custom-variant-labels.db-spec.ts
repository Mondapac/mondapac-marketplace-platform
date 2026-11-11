import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { PrismaCustomVariantLabelsReader } from '../../src/modules/catalog/infrastructure/prisma-custom-variant-labels.reader';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The "Custom variant labels" reader on PostgreSQL, for both Market fixtures: a stored label that
// is the automatic one is left out, a free label and a label missing in one locale are reported
// per locale, only the PUBLISHED revision is read, the cursor pages in variant id order, and the
// Market boundary (canary).

const T0 = Temporal.Instant.from('2026-11-04T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
let variantNoSeq = 0;

describe.each(TEST_MARKETS)('catalog custom variant labels in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const LOCALES = ['en-AU', 'ar-AU'];
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let reader: PrismaCustomVariantLabelsReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    reader = new PrismaCustomVariantLabelsReader(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>, readOnly = false) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), { readOnly });
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

  /**
   * A product with one published revision whose family has one variant axis `size` (options `l`
   * "Large" in en-AU and ar-AU, `m` "Medium" in en-AU only) and one variant per stored label set.
   */
  async function seed(target: typeof market, stored: Record<string, string>[]) {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: configurableProductType,
      familyCode: 'default',
      productCode: `P${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const productId = created.value.state.id;
    const productCode = created.value.state.productCode;
    await run(target, () => products.add(target, created.value));
    const base = { market_id: target.marketId, tenant_id: target.tenantId };
    const tag = uuid7().slice(-10);
    const familyId = uuid7();
    const familyRevisionId = uuid7();
    await insert('attribute_families', {
      id: familyId,
      ...base,
      code: `f-${tag}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_family_revisions', {
      id: familyRevisionId,
      ...base,
      family_id: familyId,
      revision_no: 1,
      groups: JSON.stringify([
        {
          groupCode: 'g',
          attributes: [{ code: `size-${tag}`, required: true, isVariantOption: true }],
        },
      ]),
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    const definitionId = uuid7();
    const definitionRevisionId = uuid7();
    await insert('attribute_definitions', {
      id: definitionId,
      ...base,
      code: `size-${tag}`,
      data_type: 'select',
      localizable: false,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_definition_revisions', {
      id: definitionRevisionId,
      ...base,
      definition_id: definitionId,
      revision_no: 1,
      material: false,
      is_variant_option: true,
      bounds: '{}',
      names: JSON.stringify({ 'en-AU': 'Size' }),
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    const optionLabels: Record<string, Record<string, string>> = {
      l: { 'en-AU': 'Large', 'ar-AU': 'كبير' },
      m: { 'en-AU': 'Medium' },
    };
    for (const [index, [optionCode, labels]] of Object.entries(optionLabels).entries()) {
      await insert('attribute_definition_revision_options', {
        ...base,
        revision_id: definitionRevisionId,
        option_code: optionCode,
        labels: JSON.stringify(labels),
        active: true,
        position: index,
        merged_into: null,
      });
    }
    await owner.query(
      `UPDATE catalog.attribute_definitions SET published_revision_id = $3
         WHERE market_id = $1 AND id = $2`,
      [target.marketId, definitionId, definitionRevisionId],
    );

    const revisionId = uuid7();
    await insert('product_revisions', {
      id: revisionId,
      ...base,
      product_id: productId,
      revision_no: 1,
      revision_kind: 'submission',
      type_code: 'simple',
      base_revision_id: null,
      reverted_from_revision_id: null,
      family_revision_id: familyRevisionId,
      definition_revision_ids: [definitionRevisionId],
      tax_category_code: 'standard',
      attribute_values: '{}',
      field_provenance: null,
      sensitive: false,
      sensitive_reasons: [],
      content_schema_version: 1,
      content_hash: `sha256:${'1'.repeat(64)}`,
      author_kind: 'admin',
      author_account_id: uuid7(),
      acting_admin_account_id: null,
      submitted_at: T0.toString(),
    });
    await insert('product_revision_texts', {
      ...base,
      revision_id: revisionId,
      locale: 'en-AU',
      name: 'Shirt',
      short_description: null,
      description: null,
    });
    const variantIds: string[] = [];
    const numbers: number[] = [];
    for (const [index, labels] of stored.entries()) {
      const variantId = uuid7();
      const variantNo = ++variantNoSeq;
      variantIds.push(variantId);
      numbers.push(variantNo);
      await insert('product_variants', {
        id: variantId,
        ...base,
        product_id: productId,
        variant_model: 'options',
        variant_no: variantNo,
        state: 'proposed',
        created_at: T0.toString(),
      });
      // Variant 0 and 1 choose `l` (their option key must differ), the others `m`.
      const optionCode = index === 0 ? 'l' : 'm';
      await insert('product_revision_variants', {
        ...base,
        revision_id: revisionId,
        variant_id: variantId,
        product_id: productId,
        position: index,
        option_key: `size=${optionCode}#${index}`,
        option_values: JSON.stringify({ [`size-${tag}`]: optionCode }),
        labels: JSON.stringify(labels),
      });
    }
    await owner.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = $3
         WHERE market_id = $1 AND id = $2`,
      [target.marketId, productId, revisionId],
    );
    return { productId, productCode, variantIds, numbers };
  }

  const page = (target: typeof market, query: { afterId?: string | null; limit?: number } = {}) =>
    run(
      target,
      () =>
        reader.page(target, {
          afterId: query.afterId ?? null,
          limit: query.limit ?? 100,
          locales: LOCALES,
        }),
      true,
    );

  it('reports free and missing labels per locale and leaves out the automatic ones', async () => {
    const a = await seed(market, [
      { 'en-AU': 'Large', 'ar-AU': 'كبير' }, // automatic
      { 'en-AU': 'Big one' }, // free label; built gives Medium in en-AU only
      {}, // no stored label; built gives Medium in en-AU
    ]);

    const mine = (await page(market)).rows.filter((row) => row.productId === a.productId);
    const byId = new Map(mine.map((row) => [row.variantId as string, row]));

    expect(byId.size).toBe(2);
    expect(byId.get(a.variantIds[1]!)).toEqual({
      productId: a.productId,
      productCode: a.productCode,
      variantId: a.variantIds[1],
      variantNo: a.numbers[1],
      variantCode: `${a.productCode}-${String(a.numbers[1]).padStart(2, '0')}`,
      differences: [{ locale: 'en-AU', stored: 'Big one', built: 'Medium' }],
    });
    expect(byId.get(a.variantIds[2]!)?.differences).toEqual([
      { locale: 'en-AU', stored: null, built: 'Medium' },
    ]);
    expect(byId.has(a.variantIds[0]!)).toBe(false);
  });

  it('pages by variant id with a cursor', async () => {
    const a = await seed(market, [{ 'en-AU': 'x1' }, { 'en-AU': 'x2' }, { 'en-AU': 'x3' }]);
    const mine = new Set(a.variantIds);

    const first = await page(market, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.nextAfterId).toBe(first.rows[0]!.variantId);

    const all: string[] = [];
    let after: string | null = null;
    do {
      const next = await page(market, { afterId: after, limit: 2 });
      all.push(...next.rows.map((row) => row.variantId as string));
      after = next.nextAfterId;
    } while (after !== null);
    expect(all.filter((id) => mine.has(id)).sort()).toEqual([...a.variantIds].sort());
    expect(all).toEqual([...all].sort());
  });

  it('never reads a product of another Market', async () => {
    const foreign = await seed(other, [{ 'en-AU': 'canary' }]);

    const answer = await page(market);

    expect(answer.rows.map((row) => row.productId)).not.toContain(foreign.productId);
  });
});
