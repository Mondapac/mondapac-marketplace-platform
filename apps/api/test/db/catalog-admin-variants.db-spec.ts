import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AdminVariantsExport } from '../../src/modules/catalog/application/use-cases/admin-variants-export.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaAdminVariantsReader } from '../../src/modules/catalog/infrastructure/prisma-admin-variants.reader';
import { PrismaVariantAdminReader } from '../../src/modules/catalog/infrastructure/prisma-variant-admin.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { ExceljsSheetWriter } from '../../src/modules/catalog/infrastructure/xlsx/exceljs-sheet-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The admin variant export on PostgreSQL, for both Market fixtures (catalog design 14b): the rows
// come from each product's PUBLISHED revision only (a never-published product, a variant that is
// only in a pending revision and a retired one give none), the option labels are the published
// definition's label in the Market's default locale, the offer count skips deleted Offers, the
// axes are the union over the exported products, and another Market's canary never shows. Each
// test works on its own code marker, because other specs share the database.

const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => uuid7().replaceAll('-', '').slice(-10);

describe.each(TEST_MARKETS)('catalog admin variants reader in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = policy.locales(market).default;
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let offers: PrismaOfferRepository;
  let reader: PrismaAdminVariantsReader;
  let exporter: AdminVariantsExport;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    offers = new PrismaOfferRepository(db.service, {
      next: <K extends string>() => uuid7() as Id<K>,
    });
    reader = new PrismaAdminVariantsReader(db.service);
    exporter = new AdminVariantsExport(
      createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) }),
      {
        unitOfWork: db.unitOfWork,
        variantAdminReader: new PrismaVariantAdminReader(db.service),
        adminVariantsReader: reader,
        policy,
        sheetWriter: new ExceljsSheetWriter(),
        clock: new FixedClock(T0),
      },
    );
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

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
  const adminContext = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: uuid7() as Id<'Account'>,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: null,
      }),
    );

  async function familyRevision(target: typeof market): Promise<string> {
    const familyId = uuid7();
    const revisionId = uuid7();
    await insert('attribute_families', {
      id: familyId,
      ...base(target),
      code: `f-${unique()}`,
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

  /** A select attribute whose published revision has these options, labelled in the Market locale. */
  async function axis(
    target: typeof market,
    attributeCode: string,
    options: Record<string, string>,
  ): Promise<void> {
    const id = uuid7();
    const revisionId = uuid7();
    await insert('attribute_definitions', {
      id,
      ...base(target),
      code: attributeCode,
      data_type: 'select',
      localizable: false,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_definition_revisions', {
      id: revisionId,
      ...base(target),
      definition_id: id,
      revision_no: 1,
      material: false,
      is_variant_option: true,
      bounds: '{}',
      names: JSON.stringify({ [policy.locales(target).default]: attributeCode }),
      author_kind: 'seed',
      author_account_id: null,
      created_at: T0.toString(),
    });
    for (const [position, [optionCode, label]] of Object.entries(options).entries()) {
      await insert('attribute_definition_revision_options', {
        ...base(target),
        revision_id: revisionId,
        option_code: optionCode,
        labels: JSON.stringify({ [policy.locales(target).default]: label }),
        active: true,
        position,
      });
    }
    await owner.query(
      `UPDATE catalog.attribute_definitions SET published_revision_id = $3
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, id, revisionId],
    );
  }

  async function revision(
    target: typeof market,
    productId: string,
    revisionNo: number,
    familyRevisionId: string,
  ): Promise<string> {
    const revisionId = uuid7();
    await insert('product_revisions', {
      id: revisionId,
      ...base(target),
      product_id: productId,
      revision_no: revisionNo,
      revision_kind: 'submission',
      base_revision_id: null,
      reverted_from_revision_id: null,
      type_code: 'configurable',
      family_revision_id: familyRevisionId,
      definition_revision_ids: [],
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
    return revisionId;
  }

  interface VariantSpec {
    readonly options: Record<string, string>;
    readonly gtin?: string | null;
    /** The registry state; the published revision lists the variant either way. */
    readonly state?: 'published' | 'retired';
    /** Listed only in the pending revision, never in the published one. */
    readonly pendingOnly?: boolean;
  }

  /** A configurable product with these variants (numbers 1, 2, ...), published or only pending. */
  async function configurable(
    target: typeof market,
    marker: string,
    specs: readonly VariantSpec[],
    published = true,
  ): Promise<{ productId: Id<'Product'>; productCode: string; variantIds: string[] }> {
    const productCode = `${marker}${unique().toUpperCase()}`;
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: configurableProductType,
      familyCode: 'default',
      productCode,
      variantId: null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const variantIds = specs.map(() => uuid7() as Id<'Variant'>);
    for (const variantId of variantIds) {
      const added = created.value.addVariant(variantId, 100, T0, 'admin');
      if (!added.ok) throw new Error(added.error.code);
    }
    const productId = created.value.state.id;
    await db.unitOfWork.run(target, async () => ok(await products.add(target, created.value)));
    const family = await familyRevision(target);
    const shownId = await revision(target, productId, 1, family);
    const pendingId = await revision(target, productId, 2, family);
    for (const [index, spec] of specs.entries()) {
      const row = (revisionId: string) => ({
        ...base(target),
        revision_id: revisionId,
        variant_id: variantIds[index],
        product_id: productId,
        position: index,
        option_key: Object.entries(spec.options)
          .map(([k, v]) => `${k}=${v}`)
          .join(';'),
        option_values: JSON.stringify(spec.options),
        labels: JSON.stringify({ [policy.locales(target).default]: `V${index + 1}` }),
        gtin: spec.gtin ?? null,
      });
      if (spec.pendingOnly !== true) await insert('product_revision_variants', row(shownId));
      await insert('product_revision_variants', row(pendingId));
      await owner.query(
        `UPDATE catalog.product_variants
            SET state = $3, published_at = now()${spec.state === 'retired' ? ', retired_at = now()' : ''}
          WHERE market_id = $1 AND id = $2`,
        [
          target.marketId,
          variantIds[index],
          spec.pendingOnly === true ? 'proposed' : (spec.state ?? 'published'),
        ],
      );
    }
    await owner.query(
      `UPDATE catalog.products
          SET status = $3, published_revision_id = $4, pending_revision_id = $5,
              pending_submitted_at = $6
        WHERE market_id = $1 AND id = $2`,
      [
        target.marketId,
        productId,
        published ? 'published' : 'unpublished',
        published ? shownId : null,
        published ? pendingId : shownId,
        T0.toString(),
      ],
    );
    return { productId, productCode, variantIds };
  }

  async function offerOn(productId: Id<'Product'>, deleted = false) {
    const offer = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: market.marketId,
      sellerId: uuid7() as Id<'Seller'>,
      productId,
      sellerSku: `sku-${unique()}`,
      conditionCode: 'new',
      description: { [locale]: 'mine' },
      now: T0,
    });
    if (!offer.ok) throw new Error(offer.error.code);
    await db.unitOfWork.run(market, async () =>
      ok(
        await offers.add(market, offer.value, {
          kind: 'seller',
          accountId: uuid7() as Id<'Account'>,
        }),
      ),
    );
    if (deleted) {
      await owner.query(
        `UPDATE catalog.offers SET status = 'deleted', deleted_at = now(), listed = false
          WHERE market_id = $1 AND id = $2`,
        [market.marketId, offer.value.state.id],
      );
    }
  }

  it('reads only the published revision: a never-published product, a pending-only variant and a retired one give no row', async () => {
    const marker = `V9C${unique().slice(0, 6).toUpperCase()}`;
    const size = `size-${unique()}`;
    await axis(market, size, { s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large' });
    const shirt = await configurable(market, marker, [
      { options: { [size]: 's' }, gtin: '00012345678905' },
      { options: { [size]: 'm' } },
      { options: { [size]: 'l' }, state: 'retired' },
      { options: { [size]: 'xl' }, pendingOnly: true },
    ]);
    const unpublished = await configurable(market, marker, [{ options: { [size]: 's' } }], false);
    const ids = [shirt.productId, unpublished.productId];

    const rows = await read(market, () => reader.rows(market, ids, locale));

    expect(rows.map((row) => row.variantCode)).toEqual([
      `${shirt.productCode}-01`,
      `${shirt.productCode}-02`,
    ]);
    expect(rows[0]).toMatchObject({
      productCode: shirt.productCode,
      typeCode: 'configurable',
      gtin: '00012345678905',
      options: [{ attributeCode: size, optionCode: 's', label: 'Small' }],
    });
    expect(rows[1]?.gtin).toBeNull();
    expect(await read(market, () => reader.count(market, ids))).toBe(2);
    expect(await read(market, () => reader.axisCodes(market, ids))).toEqual([size]);
  });

  it('counts the Offers that are not deleted, and unions the axes of different products', async () => {
    const marker = `V9C${unique().slice(0, 6).toUpperCase()}`;
    const size = `size-${unique()}`;
    const colour = `colour-${unique()}`;
    await axis(market, size, { s: 'Small' });
    await axis(market, colour, { red: 'Red' });
    const sized = await configurable(market, marker, [{ options: { [size]: 's' } }]);
    const coloured = await configurable(market, marker, [{ options: { [colour]: 'red' } }]);
    await offerOn(sized.productId);
    await offerOn(sized.productId);
    await offerOn(sized.productId, true);

    const ids = [coloured.productId, sized.productId];
    const rows = await read(market, () => reader.rows(market, ids, locale));

    // Rows follow the order of the ids.
    expect(rows.map((row) => [row.productCode, row.offerCount])).toEqual([
      [coloured.productCode, 0],
      [sized.productCode, 2],
    ]);
    expect(await read(market, () => reader.axisCodes(market, ids))).toEqual([colour, size].sort());
  });

  it('falls back to the option code when the option has no label, and never reads another Market', async () => {
    const marker = `V9C${unique().slice(0, 6).toUpperCase()}`;
    const size = `size-${unique()}`;
    await axis(market, size, { s: 'Small' });
    await axis(other, size, { s: 'Canary' });
    const mine = await configurable(market, marker, [
      { options: { [size]: 'ghost' } },
      { options: { [size]: 's' } },
    ]);
    const theirs = await configurable(other, marker, [{ options: { [size]: 's' } }]);

    const rows = await read(market, () =>
      reader.rows(market, [mine.productId, theirs.productId], locale),
    );

    expect(rows.map((row) => row.options[0]?.label)).toEqual(['ghost', 'Small']);
    expect(rows.map((row) => row.productCode)).not.toContain(theirs.productCode);
    expect(await read(market, () => reader.count(market, [theirs.productId]))).toBe(0);
  });

  it('exports through the use case as CSV and XLSX from the same rows, and refuses nothing under the cap', async () => {
    const marker = `V9C${unique().slice(0, 6).toUpperCase()}`;
    const size = `size-${unique()}`;
    await axis(market, size, { s: '=Small' });
    const shirt = await configurable(market, marker, [{ options: { [size]: 's' } }]);
    const simple = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: market.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `${marker}S${unique().toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now: T0,
    });
    if (!simple.ok) throw new Error(simple.error.code);
    await db.unitOfWork.run(market, async () => ok(await products.add(market, simple.value)));
    const family = await familyRevision(market);
    const shown = await revision(market, simple.value.state.id, 1, family);
    await insert('product_revision_variants', {
      ...base(market),
      revision_id: shown,
      variant_id: simple.value.state.variants[0]!.id,
      product_id: simple.value.state.id,
      position: 0,
      option_key: '',
      option_values: '{}',
      labels: JSON.stringify({ [locale]: 'One' }),
      gtin: null,
    });
    await owner.query(
      `UPDATE catalog.product_variants SET state = 'published', published_at = now()
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, simple.value.state.variants[0]!.id],
    );
    await owner.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = $3
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, simple.value.state.id, shown],
    );

    const result = await exporter.execute(adminContext(), { q: marker });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const text = (await collect(result.value.chunks)).replace(/^\uFEFF/, '');
    const lines = text.trim().split('\r\n');

    expect(result.value.filename).toBe('variants-2026-11-07.csv');
    expect(lines[0]).toBe(
      `product_code,variant_code,product_type,option[${size}],gtin,offer_count,` +
        'Product,Variant,Status,Sellers selling,Issues',
    );
    // The compare columns first (design 14b); the tab's own columns follow them.
    const compare = lines.slice(1).map((line) => line.split(',').slice(0, 6).join(','));
    expect(compare.sort()).toEqual(
      [
        `${shirt.productCode},${shirt.productCode}-01,configurable,'=Small,,0`,
        `${simple.value.state.productCode},${simple.value.state.productCode}-01,simple,,,0`,
      ].sort(),
    );

    const xlsx = await exporter.execute(adminContext(), { q: marker, format: 'xlsx' });
    expect(xlsx.ok && xlsx.value.contentType).toContain('spreadsheetml');
  });
});

async function collect(chunks: AsyncIterable<string | Uint8Array>): Promise<string> {
  let text = '';
  for await (const chunk of chunks) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  return text;
}
