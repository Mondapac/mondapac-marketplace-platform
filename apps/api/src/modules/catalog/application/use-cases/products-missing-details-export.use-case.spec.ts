import { Temporal } from '@mondapac/shared-kernel';
import type {
  AttributeField,
  AttributeSchema,
  CallContext,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type {
  ProductDetailsGapReader,
  PublishedProductValues,
  PublishedProductsFilter,
} from '../ports/product-details-gap.reader';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { AttributeRepository } from '../ports/attribute.repository';
import { GAP_PAGE_SCAN_MAX } from './products-missing-details-list.use-case';
import { ProductsMissingDetailsExport } from './products-missing-details-export.use-case';
import type { SheetWriter } from '../../../../platform/list-export/sheet-writer';

// The export of the report "Products missing required details" in memory (attributes plan, package A4, decision
// ت۷), on both Market fixtures: the access rule and population, the closed query, the required
// rule shared with a submit (a localizable text needs its default-locale value), the filters, the
// keyset paging with its scan cap, and a feature set that cannot be read. The SQL is in
// test/db/catalog-products-missing-details.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const SENT = Temporal.Instant.from('2026-11-10T01:02:03Z');
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const field = (code: string, over: Partial<AttributeField> = {}): AttributeField => ({
  code,
  dataType: 'text',
  localizable: false,
  required: false,
  isVariantOption: false,
  material: false,
  claimChecked: true,
  bounds: { maxLength: 100 },
  ...over,
});
const schemaOf = (fields: AttributeField[]): AttributeSchema => ({
  schemaRef: { familyRevisionId: 'fam-rev-1', definitionRevisionIds: [] } as never,
  fields,
});

class MemoryGapReader implements ProductDetailsGapReader {
  rows: PublishedProductValues[] = [];
  calls: PublishedProductsFilter[] = [];
  publishedByIds(
    _market: MarketContext,
    productIds: readonly string[],
  ): Promise<readonly PublishedProductValues[]> {
    return Promise.resolve(this.rows.filter((row) => productIds.includes(row.productId)));
  }
  published(
    _market: MarketContext,
    filter: PublishedProductsFilter,
  ): Promise<readonly PublishedProductValues[]> {
    this.calls.push(filter);
    return Promise.resolve(
      this.rows
        .filter(
          (row) =>
            (filter.afterId === null || row.productId > filter.afterId) &&
            (filter.sellerId === null || row.ownerSellerId === filter.sellerId),
        )
        .sort((a, b) => (a.productId < b.productId ? -1 : 1))
        .slice(0, filter.limit),
    );
  }
}

describe.each(['AU', 'ZZ'] as const)('missing details export in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = policy.locales(market);
  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ID(0xa1) as never,
        sessionId: ID(0xa2) as never,
        sellerId: population === 'seller' ? (ID(0xa3) as never) : null,
      }),
    );

  let reader: MemoryGapReader;
  let schemas: Record<string, AttributeSchema | null>;
  let allow: boolean;
  const check: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        allow ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const attributes = {
    loadSchema: (_m: MarketContext, familyCode: string) =>
      Promise.resolve(schemas[familyCode] ?? null),
  } as unknown as AttributeRepository;
  const familyResolver = {
    open: () =>
      Promise.resolve({
        resolve: (categoryId: string | null) =>
          Promise.resolve(
            categoryId === null
              ? ({ ok: false, code: 'family.unavailable' } as const)
              : ({ ok: true, familyCode: categoryId.slice(4) } as const),
          ),
      }),
  } as unknown as ProductFamilyResolver;
  const sheetWriter: SheetWriter = {
    async *xlsx(name, rows) {
      yield new TextEncoder().encode(`sheet:${name}\n`);
      for await (const row of rows) yield new TextEncoder().encode(`${row.join('|')}\n`);
    },
  };
  const useCase = () =>
    new ProductsMissingDetailsExport(createUseCaseGate(markets, check), {
      unitOfWork,
      detailsGapReader: reader,
      attributes,
      policy,
      familyResolver,
      sheetWriter,
      clock: { now: () => SENT },
    });
  const product = (
    n: number,
    over: Partial<PublishedProductValues> = {},
  ): PublishedProductValues => ({
    productId: ID(0x1000 + n),
    productCode: `P${n}`,
    ownerSellerId: ID(0x2000),
    revisionFamilyCode: 'pantry',
    primaryCategoryId: 'cat:pantry',
    name: `Product ${n}`,
    attributeValues: {},
    ...over,
  });
  const text = async (chunks: AsyncIterable<string | Uint8Array>): Promise<string> => {
    let out = '';
    for await (const chunk of chunks) {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    }
    return out;
  };

  beforeEach(() => {
    reader = new MemoryGapReader();
    schemas = {
      pantry: schemaOf([
        field('origin', { required: true }),
        field('storage', { required: true, localizable: true }),
      ]),
    };
    allow = true;
  });

  it('exports the gaps as CSV with a header, a BOM and the list order', async () => {
    reader.rows = [
      product(2, { attributeValues: { origin: 'AU' } }),
      product(1),
      product(3, { attributeValues: { origin: 'AU', storage: { [locales.default]: 'cool' } } }),
    ];
    const result = await useCase().execute(context(), { sort: 'missing', direction: 'desc' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filename).toBe('products-missing-details-2026-11-10.csv');
    expect(result.value.contentType).toBe('text/csv; charset=utf-8');
    const lines = (await text(result.value.chunks)).replace('\uFEFF', '').trim().split(/\r?\n/);
    expect(lines).toEqual([
      'product_code,name,seller_id,feature_set,missing_count,missing',
      `P1,Product 1,${ID(0x2000)},pantry,2,origin; storage`,
      `P2,Product 2,${ID(0x2000)},pantry,1,storage`,
    ]);
  });

  it('exports XLSX with every cell as text and filters by q, seller and feature set', async () => {
    reader.rows = [
      product(1),
      product(2, { ownerSellerId: ID(0x2001) }),
      product(3, { name: 'Dates', revisionFamilyCode: 'other', primaryCategoryId: 'cat:other' }),
    ];
    schemas['other'] = schemaOf([field('origin', { required: true })]);
    const result = await useCase().execute(context(), {
      format: 'xlsx',
      q: 'product',
      sellerId: ID(0x2001),
      familyCode: 'pantry',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filename).toBe('products-missing-details-2026-11-10.xlsx');
    expect(await text(result.value.chunks)).toBe(
      'sheet:Missing details\n' +
        'product_code|name|seller_id|feature_set|missing_count|missing\n' +
        `P2|Product 2|${ID(0x2001)}|pantry|2|origin; storage\n`,
    );
  });

  it('writes a formula-looking name with a leading quote in CSV', async () => {
    reader.rows = [product(1, { name: '=HYPERLINK("x")' })];
    const result = await useCase().execute(context(), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await text(result.value.chunks)).toContain("'=HYPERLINK");
  });

  it('refuses the whole file when the scan cap was hit before the end of the Market', async () => {
    reader.rows = Array.from({ length: GAP_PAGE_SCAN_MAX + 1 }, (_, n) => product(n + 1));
    const result = await useCase().execute(context(), {});
    expect(result).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: GAP_PAGE_SCAN_MAX },
    });
  });

  it('refuses a bad format, an unknown key, a cursor key, a malformed seller and a seller caller', async () => {
    reader.rows = [product(1)];
    const run = (input: Record<string, unknown>, ctx = context()) => useCase().execute(ctx, input);
    expect(await run({ format: 'pdf' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run({ colour: 'red' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run({ afterId: ID(1) })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run({ sellerId: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run({}, context('seller'))).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    allow = false;
    expect(await run({})).toEqual({ ok: false, error: { code: 'access.denied' } });
  });
});
