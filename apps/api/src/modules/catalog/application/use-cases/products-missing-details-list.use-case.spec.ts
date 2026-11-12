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
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type {
  ProductDetailsGapReader,
  PublishedProductValues,
  PublishedProductsFilter,
} from '../ports/product-details-gap.reader';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { AttributeRepository } from '../ports/attribute.repository';
import { GAP_SCAN_MAX, ProductsMissingDetailsList } from './products-missing-details-list.use-case';

// The report "Products missing required details" in memory (attributes plan, package A4, decision
// ت۷), on both Market fixtures: the access rule and population, the closed query, the required
// rule shared with a submit (a localizable text needs its default-locale value), the filters, the
// keyset paging with its scan cap, and a feature set that cannot be read. The SQL is in
// test/db/catalog-products-missing-details.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
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

describe.each(['AU', 'ZZ'] as const)('products missing required details in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = policy.locales(market);
  const second = locales.supported.find((l) => l !== locales.default) ?? null;

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
  let units: (UnitOfWorkOptions | undefined)[];
  let allow: boolean;
  let unitFails: boolean;

  const check: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        allow ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
      units.push(o);
      return unitFails ? Promise.resolve({ ok: false, error: new Error('down') }) : work();
    },
  } as unknown as UnitOfWork;
  const attributes = {
    loadSchema: (_m: MarketContext, familyCode: string) =>
      Promise.resolve(schemas[familyCode] ?? null),
  } as unknown as AttributeRepository;
  // A category `cat:<code>` holds the feature set `<code>`; `cat:unreadable` cannot be resolved.
  const familyResolver = {
    open: () =>
      Promise.resolve({
        resolve: (categoryId: string | null) =>
          Promise.resolve(
            categoryId === null || categoryId === 'cat:unreadable'
              ? ({ ok: false, code: 'family.unavailable' } as const)
              : ({ ok: true, familyCode: categoryId.slice(4) } as const),
          ),
      }),
  } as unknown as ProductFamilyResolver;
  const useCase = () =>
    new ProductsMissingDetailsList(createUseCaseGate(markets, check), {
      unitOfWork,
      detailsGapReader: reader,
      attributes,
      policy,
      familyResolver,
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

  beforeEach(() => {
    reader = new MemoryGapReader();
    schemas = {
      pantry: schemaOf([
        field('origin', { required: true }),
        field('storage', { required: true, localizable: true }),
        field('notes'),
      ]),
    };
    units = [];
    allow = true;
    unitFails = false;
  });

  it('lists a product whose required fields are empty, in the feature set order, once each', async () => {
    reader.rows = [
      product(1),
      product(2, { attributeValues: { origin: 'AU', storage: { [locales.default]: 'cool' } } }),
    ];
    const result = await useCase().execute(context(), {});
    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            productId: ID(0x1001),
            productCode: 'P1',
            name: 'Product 1',
            sellerId: ID(0x2000),
            featureSetCode: 'pantry',
            missing: ['origin', 'storage'],
          },
        ],
        nextAfterId: null,
        scanned: 2,
        unreadableFeatureSets: [],
      },
    });
    expect(units).toEqual([{ readOnly: true }]);
  });

  it('wants the default-locale value of a localizable text, not another language', async () => {
    if (second === null) return;
    reader.rows = [
      product(1, { attributeValues: { origin: 'AU', storage: { [second]: 'cool' } } }),
      product(2, { attributeValues: { origin: '', storage: { [locales.default]: '' } } }),
    ];
    const result = await useCase().execute(context(), {});
    expect(result.ok && result.value.items.map((i) => [i.productCode, i.missing])).toEqual([
      ['P1', ['storage']],
      ['P2', ['origin', 'storage']],
    ]);
  });

  it('reads malformed stored values as empty and ignores problems other than a missing field', async () => {
    reader.rows = [
      product(1, { attributeValues: 'oops' }),
      product(2, {
        attributeValues: { origin: 'AU', storage: { [locales.default]: 'x' }, stray: 'y' },
      }),
    ];
    const result = await useCase().execute(context(), {});
    expect(result.ok && result.value.items.map((i) => i.productCode)).toEqual(['P1']);
  });

  it('does not list a PLATFORM product with a seller id, and filters by seller and feature set', async () => {
    schemas['other'] = schemaOf([field('size', { required: true })]);
    reader.rows = [
      product(1, { ownerSellerId: null }),
      product(2, { ownerSellerId: ID(0x2001) }),
      product(3, { primaryCategoryId: 'cat:other', revisionFamilyCode: 'other' }),
    ];
    const all = await useCase().execute(context(), {});
    expect(all.ok && all.value.items.map((i) => [i.productCode, i.sellerId])).toEqual([
      ['P1', null],
      ['P2', ID(0x2001)],
      ['P3', ID(0x2000)],
    ]);
    const bySeller = await useCase().execute(context(), { sellerId: ID(0x2001) });
    expect(bySeller.ok && bySeller.value.items.map((i) => i.productCode)).toEqual(['P2']);
    const byFamily = await useCase().execute(context(), { familyCode: 'other' });
    expect(byFamily.ok && byFamily.value.items.map((i) => i.productCode)).toEqual(['P3']);
  });

  it('pages by product id and ends with a null cursor', async () => {
    reader.rows = [1, 2, 3, 4, 5].map((n) => product(n));
    const first = await useCase().execute(context(), { limit: 2 });
    expect(first.ok && first.value.items.map((i) => i.productCode)).toEqual(['P1', 'P2']);
    expect(first.ok && first.value.nextAfterId).toBe(ID(0x1002));
    const second2 = await useCase().execute(context(), { limit: 2, afterId: ID(0x1002) });
    expect(second2.ok && second2.value.items.map((i) => i.productCode)).toEqual(['P3', 'P4']);
    const last = await useCase().execute(context(), { limit: 2, afterId: ID(0x1004) });
    expect(last.ok && last.value).toMatchObject({ nextAfterId: null, scanned: 1 });
  });

  it('ends the report when a page fills on the last row of a short batch', async () => {
    reader.rows = [1, 2, 3].map((n) => product(n));
    const result = await useCase().execute(context(), { limit: 3 });
    expect(result.ok && result.value).toMatchObject({ scanned: 3, nextAfterId: null });
  });

  it('keeps a cursor when a page fills on the last row the scan cap allows', async () => {
    const complete = { origin: 'AU', storage: { [locales.default]: 'x' } };
    reader.rows = Array.from({ length: GAP_SCAN_MAX }, (_, i) =>
      product(i + 1, i < GAP_SCAN_MAX - 1 ? { attributeValues: complete } : {}),
    );
    const result = await useCase().execute(context(), { limit: 1 });
    expect(result.ok && result.value.items.map((i) => i.productCode)).toEqual([`P${GAP_SCAN_MAX}`]);
    expect(result.ok && result.value.scanned).toBe(GAP_SCAN_MAX);
    expect(result.ok && result.value.nextAfterId).toBe(ID(0x1000 + GAP_SCAN_MAX));
  });

  it('skips products that are complete and stops a long scan at the cap with a cursor', async () => {
    const complete = { origin: 'AU', storage: { [locales.default]: 'x' } };
    reader.rows = Array.from({ length: GAP_SCAN_MAX + 5 }, (_, i) =>
      product(i + 1, { attributeValues: complete }),
    );
    const first = await useCase().execute(context(), {});
    expect(first.ok && first.value.items).toEqual([]);
    expect(first.ok && first.value.scanned).toBe(GAP_SCAN_MAX);
    const cursor = first.ok ? first.value.nextAfterId : null;
    expect(cursor).toBe(ID(0x1000 + GAP_SCAN_MAX));
    const rest = await useCase().execute(context(), { afterId: cursor });
    expect(rest.ok && rest.value).toMatchObject({ scanned: 5, nextAfterId: null });
  });

  it('judges a product against the feature set its primary category holds now, not the one it was frozen under', async () => {
    schemas['other'] = schemaOf([field('size', { required: true })]);
    reader.rows = [product(1, { primaryCategoryId: 'cat:other' }), product(2)];
    const result = await useCase().execute(context(), {});
    expect(result.ok && result.value.items.map((i) => [i.productCode, i.featureSetCode])).toEqual([
      ['P1', 'other'],
      ['P2', 'pantry'],
    ]);
  });

  it('falls back to the revision feature set when the category cannot be resolved', async () => {
    reader.rows = [
      product(1, { primaryCategoryId: 'cat:unreadable' }),
      product(2, { primaryCategoryId: null }),
    ];
    const result = await useCase().execute(context(), {});
    expect(result.ok && result.value.items.map((i) => i.featureSetCode)).toEqual([
      'pantry',
      'pantry',
    ]);
  });

  it('names a feature set it cannot read and does not judge its products', async () => {
    schemas['gone'] = null;
    reader.rows = [
      product(1, { primaryCategoryId: 'cat:gone', revisionFamilyCode: 'gone' }),
      product(2),
    ];
    const result = await useCase().execute(context(), {});
    expect(result.ok && result.value.items.map((i) => i.productCode)).toEqual(['P2']);
    expect(result.ok && result.value.unreadableFeatureSets).toEqual(['gone']);
  });

  it.each([
    [{ afterId: 'x' }, 'afterId'],
    [{ sellerId: 5 }, 'sellerId'],
    [{ familyCode: 'Bad Code' }, 'familyCode'],
    [{ limit: 0 }, 'limit'],
    [{ limit: 101 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ other: 1 }, 'other'],
  ])('refuses the query %j', async (input, path) => {
    const result = await useCase().execute(context(), input as Record<string, unknown>);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path }] },
    });
    expect(reader.calls).toEqual([]);
  });

  it('refuses without the permission, outside the admin population, and when the unit is down', async () => {
    allow = false;
    expect(await useCase().execute(context(), {})).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    allow = true;
    expect(await useCase().execute(context('seller'), {})).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    unitFails = true;
    expect(await useCase().execute(context(), {})).toMatchObject({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });
});
