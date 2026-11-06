import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaAttributeAdminReader } from '../../src/modules/catalog/infrastructure/prisma-attribute-admin.reader';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The admin attribute reader on PostgreSQL (attributes plan, package A1), for both Market
// fixtures: definitions with their current revision and options, the revision history, the
// families, and the product counts: a published product counts when its published revision holds
// a value (in attribute_values, or on a variant for a variant option), per value for selects
// (equality) and multi-selects (containment), and per family. A draft, a pending-only product, a
// JSON null and the other Market never count. Each test works on its own codes, because other
// specs share the database.

const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => uuid7().replaceAll('-', '').slice(-10);

describe.each(TEST_MARKETS)('catalog attribute admin reader in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let reader: PrismaAttributeAdminReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    reader = new PrismaAttributeAdminReader(db.service);
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

  interface Option {
    readonly code: string;
    readonly labels: Record<string, string>;
    readonly active?: boolean;
  }

  /** A definition with `revisions` revisions (the last published), each with these options. */
  async function definition(
    target: typeof market,
    options: {
      readonly code?: string;
      readonly dataType?: string;
      readonly variant?: boolean;
      readonly revisions?: readonly {
        readonly names: Record<string, string>;
        readonly options?: readonly Option[];
        readonly material?: boolean;
      }[];
    } = {},
  ): Promise<{ id: Id<'AttributeDefinition'>; code: string }> {
    const id = uuid7();
    const attributeCode = options.code ?? `a-${unique()}`;
    await insert('attribute_definitions', {
      id,
      ...base(target),
      code: attributeCode,
      data_type: options.dataType ?? 'text',
      localizable: false,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    const revisions = options.revisions ?? [{ names: { 'en-AU': 'Name' } }];
    let last = '';
    for (const [index, revision] of revisions.entries()) {
      last = uuid7();
      await insert('attribute_definition_revisions', {
        id: last,
        ...base(target),
        definition_id: id,
        revision_no: index + 1,
        material: revision.material ?? false,
        is_variant_option: options.variant ?? false,
        bounds: '{}',
        names: JSON.stringify(revision.names),
        author_kind: index === 0 ? 'seed' : 'admin',
        author_account_id: index === 0 ? null : uuid7(),
        created_at: T0.add({ hours: index }).toString(),
      });
      for (const [position, option] of (revision.options ?? []).entries()) {
        await insert('attribute_definition_revision_options', {
          ...base(target),
          revision_id: last,
          option_code: option.code,
          labels: JSON.stringify(option.labels),
          active: option.active ?? true,
          position,
        });
      }
    }
    await owner.query(
      `UPDATE catalog.attribute_definitions SET published_revision_id = $3
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, id, last],
    );
    return { id: id as Id<'AttributeDefinition'>, code: attributeCode };
  }

  async function family(
    target: typeof market,
    groups: readonly unknown[],
  ): Promise<{ id: Id<'AttributeFamily'>; code: string; revisionId: string }> {
    const id = uuid7();
    const revisionId = uuid7();
    const familyCode = `f-${unique()}`;
    await insert('attribute_families', {
      id,
      ...base(target),
      code: familyCode,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_family_revisions', {
      id: revisionId,
      ...base(target),
      family_id: id,
      revision_no: 1,
      groups: JSON.stringify(groups),
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    await owner.query(
      `UPDATE catalog.attribute_families SET published_revision_id = $3
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, id, revisionId],
    );
    return { id: id as Id<'AttributeFamily'>, code: familyCode, revisionId };
  }

  /** A product with one revision holding these values; published unless told otherwise. */
  async function product(
    target: typeof market,
    familyRevisionId: string,
    values: Record<string, unknown>,
    options: {
      readonly status?: 'published' | 'draft';
      readonly pendingOnly?: boolean;
      readonly variantValues?: Record<string, string>;
    } = {},
  ): Promise<void> {
    const variantId = uuid7() as Id<'Variant'>;
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `X${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const productId = created.value.state.id;
    await db.unitOfWork.run(target, async () => ok(await products.add(target, created.value)));
    const revisionId = uuid7();
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
      attribute_values: JSON.stringify(values),
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
    if (options.variantValues !== undefined) {
      await insert('product_revision_variants', {
        ...base(target),
        revision_id: revisionId,
        variant_id: variantId,
        product_id: productId,
        position: 0,
        option_key: Object.entries(options.variantValues)
          .map(([k, v]) => `${k}=${v}`)
          .join(';'),
        option_values: JSON.stringify(options.variantValues),
        labels: JSON.stringify({ 'en-AU': 'One' }),
      });
    }
    // A product only pending review was never published: `unpublished` with a pending revision.
    const status = options.pendingOnly === true ? 'unpublished' : (options.status ?? 'published');
    await owner.query(
      `UPDATE catalog.products
          SET status = $3, ${options.pendingOnly === true ? 'pending_revision_id' : 'published_revision_id'} = $4,
              pending_submitted_at = $5
        WHERE market_id = $1 AND id = $2`,
      [
        target.marketId,
        productId,
        status,
        status === 'draft' ? null : revisionId,
        options.pendingOnly === true ? T0.toString() : null,
      ],
    );
  }

  it('names the attribute an archived definition was merged into, and only that one', async () => {
    const target = await definition(market, { dataType: 'select' });
    const source = await definition(market, { dataType: 'select' });
    expect((await run(market, () => reader.definition(market, source.id)))?.mergedInto).toBeNull();
    await owner.query(
      `UPDATE catalog.attribute_definitions SET status = 'archived', merged_into_id = $3, version = version + 1
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, source.id, target.id],
    );
    expect(await run(market, () => reader.definition(market, source.id))).toMatchObject({
      status: 'archived',
      mergedInto: { id: target.id, code: target.code },
    });
    expect((await run(market, () => reader.definition(market, target.id)))?.mergedInto).toBeNull();
  });

  it('reads a definition with its current revision and options, and its history newest first', async () => {
    const made = await definition(market, {
      dataType: 'select',
      revisions: [
        { names: { 'en-AU': 'Pack' }, options: [{ code: 'g250', labels: { 'en-AU': '250 g' } }] },
        {
          names: { 'en-AU': 'Pack size' },
          material: true,
          options: [
            { code: 'g250', labels: { 'en-AU': '250 g' } },
            { code: 'g500', labels: { 'en-AU': '500 g' }, active: false },
          ],
        },
      ],
    });
    const record = await run(market, () => reader.definition(market, made.id));
    expect(record).toMatchObject({
      id: made.id,
      code: made.code,
      dataType: 'select',
      status: 'active',
      revision: {
        revisionNo: 2,
        material: true,
        names: { 'en-AU': 'Pack size' },
        authorKind: 'admin',
        options: [
          { code: 'g250', labels: { 'en-AU': '250 g' }, active: true, position: 0 },
          { code: 'g500', labels: { 'en-AU': '500 g' }, active: false, position: 1 },
        ],
      },
    });
    const history = await run(market, () => reader.revisions(market, made.id, 10));
    expect(history.map((revision) => [revision.revisionNo, revision.authorKind])).toEqual([
      [2, 'admin'],
      [1, 'seed'],
    ]);
    expect(history[1]!.authorAccountId).toBeNull();
    expect(await run(market, () => reader.revisions(market, made.id, 1))).toHaveLength(1);
    // Another Market never sees it.
    expect(await run(other, () => reader.definition(other, made.id))).toBeNull();
    const all = await run(market, () => reader.definitions(market, 5000));
    expect(all.map((entry) => entry.code)).toContain(made.code);
    expect(all.map((entry) => entry.code)).toEqual([...all.map((entry) => entry.code)].sort());
    const elsewhere = await run(other, () => reader.definitions(other, 5000));
    expect(elsewhere.map((entry) => entry.id)).not.toContain(made.id);
  });

  it('reads the families with their groups, and one by id', async () => {
    const groups = [
      {
        groupCode: 'general',
        attributes: [{ code: 'brand', required: true, isVariantOption: false }],
      },
    ];
    const made = await family(market, groups);
    const one = await run(market, () => reader.featureSet(market, made.id));
    expect(one).toMatchObject({
      id: made.id,
      code: made.code,
      status: 'active',
      revisionNo: 1,
      groups,
    });
    expect(await run(other, () => reader.featureSet(other, made.id))).toBeNull();
    const all = await run(market, () => reader.featureSets(market, 500));
    expect(all.map((entry) => entry.id)).toContain(made.id);
  });

  it('counts the published products holding a value, per field, value and family', async () => {
    const text = await definition(market);
    const select = await definition(market, {
      dataType: 'select',
      variant: true,
      revisions: [
        {
          names: { 'en-AU': 'Size' },
          options: [
            { code: 'small', labels: { 'en-AU': 'Small' } },
            { code: 'large', labels: { 'en-AU': 'Large' } },
          ],
        },
      ],
    });
    const multi = await definition(market, {
      dataType: 'multi-select',
      revisions: [
        {
          names: { 'en-AU': 'Diet' },
          options: [
            { code: 'veg', labels: { 'en-AU': 'Vegetarian' } },
            { code: 'nuts', labels: { 'en-AU': 'Nut free' } },
          ],
        },
      ],
    });
    const set = await family(market, []);
    const otherSet = await family(other, []);
    await product(market, set.revisionId, { [text.code]: 'Acme', [multi.code]: ['veg', 'nuts'] });
    await product(market, set.revisionId, { [text.code]: 'Other', [select.code]: 'small' });
    // The value on a variant only: counts for the variant option.
    await product(market, set.revisionId, {}, { variantValues: { [select.code]: 'large' } });
    // A JSON null is no value.
    await product(market, set.revisionId, { [text.code]: null, [multi.code]: ['veg'] });
    // Never count: a draft, a product only pending review, and the other Market.
    await product(market, set.revisionId, { [text.code]: 'Draft' }, { status: 'draft' });
    await product(market, set.revisionId, { [text.code]: 'Pending' }, { pendingOnly: true });
    await product(other, otherSet.revisionId, { [text.code]: 'Elsewhere', [select.code]: 'small' });

    const counts = await run(market, () =>
      reader.productCounts(market, [
        { code: text.code, isVariantOption: false },
        { code: select.code, isVariantOption: true },
        { code: multi.code, isVariantOption: false },
        { code: `none-${unique()}`, isVariantOption: false },
      ]),
    );
    expect([...counts.values()]).toEqual([2, 2, 2, 0]);

    const sizes = await run(market, () =>
      reader.optionProductCounts(
        market,
        { code: select.code, isVariantOption: true, dataType: 'select' },
        ['small', 'large', 'medium'],
      ),
    );
    expect(Object.fromEntries(sizes)).toEqual({ small: 1, large: 1, medium: 0 });
    const diets = await run(market, () =>
      reader.optionProductCounts(
        market,
        { code: multi.code, isVariantOption: false, dataType: 'multi-select' },
        ['veg', 'nuts'],
      ),
    );
    expect(Object.fromEntries(diets)).toEqual({ veg: 2, nuts: 1 });
    // A field that is not a select has no per-value counts.
    expect(
      (
        await run(market, () =>
          reader.optionProductCounts(
            market,
            { code: text.code, isVariantOption: false, dataType: 'text' },
            ['x'],
          ),
        )
      ).size,
    ).toBe(0);

    const families = await run(market, () =>
      reader.featureSetProductCounts(market, [set.id, otherSet.id]),
    );
    expect(Object.fromEntries(families)).toEqual({ [set.id]: 4, [otherSet.id]: 0 });
    const fromOther = await run(other, () =>
      reader.productCounts(other, [{ code: text.code, isVariantOption: false }]),
    );
    expect([...fromOther.values()]).toEqual([1]);
  });
});
