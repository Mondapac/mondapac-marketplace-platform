import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import {
  DEFAULT_VARIANT_TYPE_SETTINGS,
  VariantTypeSettings,
} from '../../src/modules/catalog/domain/variant-type-settings';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaVariantAdminReader } from '../../src/modules/catalog/infrastructure/prisma-variant-admin.reader';
import { PrismaVariantTypeSettingsStore } from '../../src/modules/catalog/infrastructure/prisma-variant-type-settings.store';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The admin Variants page's reader and the variant type settings store on PostgreSQL (variants
// V6), for both Market fixtures: a variant type and its settings revisions, the variants of live
// products filtered by type, text and each issue (the JSON missing-locale filter included), the
// issue counts, the cursor, the insert-only revisions, and the Market boundary (canary).

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
let variantNoSeq = 0;
let gtinSeq = 0;
/** A GTIN no other test file uses: 14 digits from the clock and a counter. */
const freshGtin = (): string =>
  `7${String(Date.now()).slice(-9)}${String(++gtinSeq).padStart(4, '0')}`;

describe.each(TEST_MARKETS)('catalog variant admin in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  // The Market's own locales (ZZ: ja-JP and en-US); AU supports one, so a second is passed as the
  // reader takes the locale list from its caller.
  const LOCALES = code === 'ZZ' ? ['ja-JP', 'en-US'] : ['en-AU', 'ar-AU'];
  const [L0, L1] = LOCALES as [string, string];
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let reader: PrismaVariantAdminReader;
  let store: PrismaVariantTypeSettingsStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    reader = new PrismaVariantAdminReader(db.service);
    store = new PrismaVariantTypeSettingsStore(db.service);
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

  /** A variant type `size-<tag>` (options `l`, `m`) offered by one published feature set. */
  async function seedType(target: typeof market) {
    const base = { market_id: target.marketId, tenant_id: target.tenantId };
    const tag = uuid7().slice(-10);
    const typeCode = `size-${tag}`;
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
      names: JSON.stringify({ [L0]: `Family ${tag}` }),
      groups: JSON.stringify([
        { groupCode: 'g', attributes: [{ code: typeCode, required: true, isVariantOption: true }] },
      ]),
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    await owner.query(
      `UPDATE catalog.attribute_families SET published_revision_id = $3
         WHERE market_id = $1 AND id = $2`,
      [target.marketId, familyId, familyRevisionId],
    );
    const definitionId = uuid7();
    const definitionRevisionId = uuid7();
    await insert('attribute_definitions', {
      id: definitionId,
      ...base,
      code: typeCode,
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
      names: JSON.stringify({ [L0]: 'Size' }),
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    const optionLabels: Record<string, Record<string, string>> = {
      l: { [L0]: 'Large', [L1]: 'كبير' },
      m: { [L0]: 'Medium' },
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
    return {
      definitionId: definitionId as Id<'AttributeDefinition'>,
      definitionRevisionId,
      familyId,
      familyRevisionId,
      typeCode,
    };
  }

  /** One published product of the type with one variant per given variant. */
  async function seedProduct(
    target: typeof market,
    type: Awaited<ReturnType<typeof seedType>>,
    variants: readonly { option: string; labels: Record<string, string>; gtin: string | null }[],
    options: { status?: 'published' | 'draft'; name?: string } = {},
  ) {
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
    const revisionId = uuid7();
    await insert('product_revisions', {
      id: revisionId,
      ...base,
      product_id: productId,
      revision_no: 1,
      revision_kind: 'submission',
      base_revision_id: null,
      reverted_from_revision_id: null,
      family_revision_id: type.familyRevisionId,
      definition_revision_ids: [type.definitionRevisionId],
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
      locale: L0,
      name: options.name ?? 'Basmati rice',
      short_description: null,
      description: null,
    });
    const variantIds: string[] = [];
    for (const [index, variant] of variants.entries()) {
      const variantId = uuid7();
      variantIds.push(variantId);
      await insert('product_variants', {
        id: variantId,
        ...base,
        product_id: productId,
        variant_model: 'options',
        variant_no: ++variantNoSeq,
        state: 'proposed',
        created_at: T0.toString(),
      });
      await insert('product_revision_variants', {
        ...base,
        revision_id: revisionId,
        variant_id: variantId,
        product_id: productId,
        position: index,
        option_key: `${type.typeCode}=${variant.option}#${index}`,
        option_values: JSON.stringify({ [type.typeCode]: variant.option }),
        labels: JSON.stringify(variant.labels),
        gtin: variant.gtin,
      });
    }
    if ((options.status ?? 'published') === 'published') {
      await owner.query(
        `UPDATE catalog.products SET status = 'published', published_revision_id = $3
           WHERE market_id = $1 AND id = $2`,
        [target.marketId, productId, revisionId],
      );
    }
    return { productId, productCode, variantIds };
  }

  const page = (
    target: typeof market,
    query: {
      typeCode: string;
      text?: string | null;
      issue?:
        | 'no-seller-selling'
        | 'missing-gtin'
        | 'duplicate-gtin'
        | 'no-image'
        | 'missing-language'
        | null;
      after?: string | null;
      limit?: number;
    },
  ) =>
    run(
      target,
      () =>
        reader.variantsPage(target, {
          text: query.text ?? null,
          typeCode: query.typeCode,
          issue: query.issue ?? null,
          after: query.after ?? null,
          limit: query.limit ?? 100,
          locale: L0,
          locales: LOCALES,
        }),
      true,
    );
  const idsOf = (rows: readonly { variantId: string }[]) => rows.map((row) => row.variantId);

  it('reads a variant type with its options, the defaults, its feature set and its counts', async () => {
    const type = await seedType(market);
    await seedProduct(market, type, [
      { option: 'l', labels: { [L0]: 'Large' }, gtin: null },
      { option: 'm', labels: { [L0]: 'Medium' }, gtin: null },
    ]);
    await seedProduct(market, type, [{ option: 'l', labels: {}, gtin: null }], { status: 'draft' });

    const record = await run(market, () => reader.variantType(market, type.definitionId), true);
    expect(record).toMatchObject({
      id: type.definitionId,
      code: type.typeCode,
      status: 'active',
      names: { [L0]: 'Size' },
      settings: DEFAULT_VARIANT_TYPE_SETTINGS,
      settingsVersion: 0,
    });
    expect(record!.options.map((o) => [o.code, o.active, o.position])).toEqual([
      ['l', true, 0],
      ['m', true, 1],
    ]);
    const listed = await run(market, () => reader.variantTypes(market, 1000), true);
    expect(listed.map((t) => t.id)).toContain(type.definitionId);

    const counts = await run(market, () => reader.typeCounts(market, [type.typeCode]), true);
    expect(counts.get(type.typeCode)).toEqual({ products: 1, liveVariants: 2 });
    const options = await run(
      market,
      () => reader.optionProductCounts(market, type.typeCode, ['l', 'm']),
      true,
    );
    expect([options.get('l'), options.get('m')]).toEqual([1, 1]);
    const sets = await run(market, () => reader.featureSetsUsing(market, [type.typeCode]), true);
    expect(sets.get(type.typeCode)?.map((s) => s.id)).toEqual([type.familyId]);
  });

  it('stores settings as insert-only revisions behind a version, and the reader shows them', async () => {
    const type = await seedType(market);
    const account = uuid7() as Id<'Account'>;
    const first = VariantTypeSettings.create({
      marketId: market.marketId,
      definitionId: type.definitionId,
      revisionId: uuid7() as Id<'VariantTypeSettingRevision'>,
      content: {
        displayStyle: 'swatches',
        optionOrder: 'by-size',
        swatches: { l: '#AA0000' },
        sellerHelp: { [L0]: 'Pick the size on the label.' },
      },
      optionCodes: new Set(['l', 'm']),
      locales: LOCALES,
      now: T0,
    });
    if (!first.ok) throw new Error(first.error.code);
    await run(market, () => store.add(market, first.value, account));

    const found = await run(market, () => store.find(market, type.definitionId), true);
    expect(found?.state).toMatchObject({ version: 1, revisionNo: 1, displayStyle: 'swatches' });
    const second = found!.revise({
      revisionId: uuid7() as Id<'VariantTypeSettingRevision'>,
      content: { ...DEFAULT_VARIANT_TYPE_SETTINGS, displayStyle: 'dropdown' },
      optionCodes: new Set(['l', 'm']),
      locales: LOCALES,
      now: T0,
    });
    if (!second.ok) throw new Error(second.error.code);
    await run(market, () => store.saveRevision(market, second.value, account));

    const record = await run(market, () => reader.variantType(market, type.definitionId), true);
    expect(record).toMatchObject({
      settings: { displayStyle: 'dropdown', optionOrder: 'manual', swatches: {}, sellerHelp: {} },
      settingsVersion: 2,
    });

    // A write that read version 1 again is stale: the version moved.
    await expect(
      run(market, () => store.saveRevision(market, second.value, account)),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    // The revisions are insert-only, even for the owner.
    await expect(
      owner.query(
        `UPDATE catalog.variant_type_setting_revisions SET display_style = 'buttons'
           WHERE market_id = $1 AND definition_id = $2`,
        [market.marketId, type.definitionId],
      ),
    ).rejects.toThrow();
    const { rows } = await owner.query<{ revision_no: number }>(
      `SELECT revision_no FROM catalog.variant_type_setting_revisions
         WHERE market_id = $1 AND definition_id = $2 ORDER BY revision_no`,
      [market.marketId, type.definitionId],
    );
    expect(rows.map((r) => r.revision_no)).toEqual([1, 2]);
  });

  it('filters the live variants of a type by each issue and counts them alike', async () => {
    const type = await seedType(market);
    const shared = freshGtin();
    const a = await seedProduct(market, type, [
      { option: 'l', labels: { [L0]: 'Large', [L1]: 'كبير' }, gtin: shared },
      { option: 'm', labels: { [L0]: 'Medium' }, gtin: freshGtin() },
    ]);
    const b = await seedProduct(market, type, [
      { option: 'l', labels: {}, gtin: shared },
      { option: 'm', labels: { [L0]: 'Medium', [L1]: '' }, gtin: null },
    ]);
    const [a0, a1] = a.variantIds as [string, string];
    const [b0, b1] = b.variantIds as [string, string];

    const all = await page(market, { typeCode: type.typeCode });
    expect(idsOf(all.rows)).toEqual([b1, b0, a1, a0]);
    expect(all.nextAfter).toBeNull();
    const byId = new Map(all.rows.map((row) => [row.variantId as string, row]));
    expect(byId.get(a0)).toMatchObject({
      productId: a.productId,
      productCode: a.productCode,
      productName: 'Basmati rice',
      productScope: 'PLATFORM',
      productPaused: false,
      gtin: shared,
      duplicateGtin: true,
      sellers: 0,
      ownImages: 0,
      productImages: 0,
      missingLocales: [],
    });
    expect(byId.get(a1)).toMatchObject({ duplicateGtin: false, missingLocales: [L1] });
    expect(byId.get(b0)?.missingLocales).toEqual([L0, L1]);

    const issue = async (name: Parameters<typeof page>[1]['issue']) =>
      idsOf((await page(market, { typeCode: type.typeCode, issue: name })).rows).sort();
    expect(await issue('missing-gtin')).toEqual([b1]);
    expect(await issue('duplicate-gtin')).toEqual([a0, b0].sort());
    expect(await issue('missing-language')).toEqual([a1, b0, b1].sort());
    expect(await issue('no-seller-selling')).toEqual([a0, a1, b0, b1].sort());
    expect(await issue('no-image')).toEqual([a0, a1, b0, b1].sort());

    const counts = await run(
      market,
      () => reader.issueCounts(market, { typeCode: type.typeCode, locales: LOCALES }),
      true,
    );
    expect(counts).toEqual({
      'no-seller-selling': 4,
      'missing-gtin': 1,
      'duplicate-gtin': 2,
      'no-image': 4,
      'missing-language': 3,
    });
  });

  it('searches the product code, the variant code and the GTIN digits, and pages newest first', async () => {
    const type = await seedType(market);
    const gtin = freshGtin();
    const a = await seedProduct(market, type, [
      { option: 'l', labels: { [L0]: 'Large' }, gtin },
      { option: 'm', labels: { [L0]: 'Medium' }, gtin: null },
      { option: 'l', labels: { [L0]: 'Large' }, gtin: null },
    ]);

    const byCode = await page(market, {
      typeCode: type.typeCode,
      text: a.productCode.toLowerCase(),
    });
    expect(idsOf(byCode.rows).sort()).toEqual([...a.variantIds].sort());
    const byGtin = await page(market, { typeCode: type.typeCode, text: gtin.slice(-8) });
    expect(idsOf(byGtin.rows)).toEqual([a.variantIds[0]]);
    const variantCode = byCode.rows.find((r) => r.variantId === a.variantIds[1])!.variantCode;
    const byVariant = await page(market, { typeCode: type.typeCode, text: variantCode });
    expect(idsOf(byVariant.rows)).toEqual([a.variantIds[1]]);
    const byName = await page(market, { typeCode: type.typeCode, text: 'BASMATI' });
    expect(idsOf(byName.rows).sort()).toEqual([...a.variantIds].sort());
    const none = await page(market, { typeCode: type.typeCode, text: 'no-such-thing' });
    expect(none.rows).toEqual([]);

    const seen: string[] = [];
    let after: string | null = null;
    do {
      const next = await page(market, { typeCode: type.typeCode, after, limit: 2 });
      seen.push(...idsOf(next.rows));
      after = next.nextAfter;
    } while (after !== null);
    expect(seen).toEqual([...a.variantIds].sort().reverse());
  });

  it('never reads a type, a variant or settings of another Market (canary)', async () => {
    const foreign = await seedType(other);
    await seedProduct(other, foreign, [{ option: 'l', labels: {}, gtin: null }]);

    expect(
      await run(market, () => reader.variantType(market, foreign.definitionId), true),
    ).toBeNull();
    expect(
      (await run(market, () => reader.variantTypes(market, 1000), true)).map((t) => t.id),
    ).not.toContain(foreign.definitionId);
    expect((await page(market, { typeCode: foreign.typeCode })).rows).toEqual([]);
    expect(await run(market, () => store.find(market, foreign.definitionId), true)).toBeNull();
  });
});
