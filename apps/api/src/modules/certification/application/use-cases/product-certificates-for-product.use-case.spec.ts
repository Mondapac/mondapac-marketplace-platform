import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
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
import { CERTIFICATION_PRODUCT_CERTIFICATE_VIEW } from '../../contracts/permissions';
import type {
  ProductCertificateForProductRow,
  ProductCertificationRepository,
  ProductCoverageSource,
} from '../ports/product-certification.repository';
import {
  englishNameOf,
  ProductCertificatesForProduct,
  type ProductCertificatesForProductDependencies,
} from './product-certificates-for-product.use-case';

// The product page's lookup without a database, on both Market fixtures: the access rule, the
// refusals before any read, the Market scope, the answer shape (no number, no document) and the
// source order approved, then pending, then draft. The query over the real tables is in
// test/db/certification-product-certification.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const ID = '0192b3c4-0000-7000-8000-000000000001';
const PRODUCT = '0192b3c4-0000-7000-8000-0000000000a1';
const VARIANT_1 = '0192b3c4-0000-7000-8000-0000000000b1' as Id<'Variant'>;
const VARIANT_2 = '0192b3c4-0000-7000-8000-0000000000b2' as Id<'Variant'>;
const T0 = Temporal.Instant.from('2026-10-18T00:00:00Z');

const source = (
  issuerName: string | null,
  expiry: string | null,
  variantIds: (Id<'Variant'> | null)[],
): ProductCoverageSource => ({
  issuerName,
  expiryDate: expiry === null ? null : Temporal.PlainDate.from(expiry),
  variantIds,
});

function row(
  marketId: string,
  overrides: Partial<ProductCertificateForProductRow> = {},
): ProductCertificateForProductRow {
  return {
    id: `0192b3c4-0000-7000-8000-${marketId === 'AU' ? '1' : '2'}00000000001` as Id<'ProductCertification'>,
    typeId: ID as Id<'CertificationType'>,
    typeCode: 'halal-manufacturer',
    typeNames: {},
    status: 'draft',
    lastChangedAt: T0,
    version: 3,
    draft: null,
    pending: null,
    approved: null,
    rejectionReasonCode: null,
    ...overrides,
  };
}

/** Rows per Market; records the calls it gets. */
class FakeProducts {
  readonly byMarket = new Map<string, ProductCertificateForProductRow[]>();
  readonly calls: { marketId: string; productId: string; limit: number }[] = [];
  forProduct(market: MarketContext, productId: string, limit: number) {
    this.calls.push({ marketId: market.marketId, productId, limit });
    return Promise.resolve(this.byMarket.get(market.marketId) ?? []);
  }
}

const unitOfWork = {
  run: (_market: MarketContext, work: () => Promise<unknown>) => work(),
} as unknown as UnitOfWork;

describe('product-certificates.for-product access declaration', () => {
  it('needs the view key', () => {
    expect(ProductCertificatesForProduct.access).toEqual({
      name: 'certification.product-certificates-for-product',
      rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key] },
    });
  });
});

describe('englishNameOf', () => {
  it('prefers en, then the first en-* locale, else null', () => {
    expect(englishNameOf({ en: 'A', 'en-AU': 'B' })).toBe('A');
    expect(englishNameOf({ 'ja-JP': 'J', 'en-US': 'U', 'en-AU': 'B' })).toBe('B');
    expect(englishNameOf({ 'ja-JP': 'J' })).toBeNull();
    expect(englishNameOf({})).toBeNull();
  });
});

describe.each(['AU', 'ZZ'] as const)('product-certificates.for-product in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const other: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const locales = markets.get(market.marketId).supportedLocales;
  const products = new FakeProducts();
  let unreadable = false;

  const useCase = (
    overrides: Partial<ProductCertificatesForProductDependencies> = {},
  ): ProductCertificatesForProduct =>
    new ProductCertificatesForProduct(gate, {
      unitOfWork,
      products: products as unknown as ProductCertificationRepository,
      marketLocales: (m) => (unreadable ? null : markets.get(m.marketId).supportedLocales),
      ...overrides,
    });

  const contextOf = (population: 'admin' | 'seller', m: MarketContext = market): CallContext =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population,
        accountId: ID as Id<'Account'>,
        sessionId: ID as Id<'Session'>,
        sellerId: population === 'seller' ? (ID as Id<'Seller'>) : null,
      }),
    );

  beforeEach(() => {
    products.byMarket.clear();
    products.calls.length = 0;
    unreadable = false;
  });

  it('refuses a seller before any read', async () => {
    expect(await useCase().execute(contextOf('seller'), { productId: PRODUCT })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(products.calls).toEqual([]);
  });

  it.each([[undefined], ['nope'], [42], [null]])(
    'refuses productId %p with validation.failed before any read',
    async (productId) => {
      expect(await useCase().execute(contextOf('admin'), { productId })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'productId', code: 'format' }] },
      });
      expect(products.calls).toEqual([]);
    },
  );

  it('is unavailable when the Market locales are unknown, before any read', async () => {
    unreadable = true;
    expect(await useCase().execute(contextOf('admin'), { productId: PRODUCT })).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(products.calls).toEqual([]);
  });

  it('reads only the caller Market, with the product and the limit of 100', async () => {
    products.byMarket.set(other.marketId, [row(other.marketId, { status: 'approved' })]);
    products.byMarket.set(market.marketId, [row(market.marketId)]);
    const result = await useCase().execute(contextOf('admin'), { productId: PRODUCT });
    expect(products.calls).toEqual([{ marketId: market.marketId, productId: PRODUCT, limit: 100 }]);
    expect(result.ok && result.value.items.map((item) => item.id)).toEqual([
      row(market.marketId).id,
    ]);
    const none = await useCase().execute(contextOf('admin', other), { productId: PRODUCT });
    expect(none.ok && none.value.items.map((item) => item.id)).toEqual([row(other.marketId).id]);
  });

  it('answers an empty list when no certificate names the product', async () => {
    expect(await useCase().execute(contextOf('admin'), { productId: PRODUCT })).toEqual({
      ok: true,
      value: { items: [] },
    });
  });

  it('answers the clear fields only: no number, no ciphertext, no document', async () => {
    products.byMarket.set(market.marketId, [
      row(market.marketId, {
        status: 'approved',
        typeNames: { [locales[0]!]: 'Manufacturer halal certificate' },
        approved: source('Halal Authority', '2027-05-01', [null]),
      }),
    ]);
    const result = await useCase().execute(contextOf('admin'), { productId: PRODUCT });
    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            id: row(market.marketId).id,
            typeId: ID,
            typeCode: 'halal-manufacturer',
            typeName: locales[0]!.toLowerCase().startsWith('en')
              ? 'Manufacturer halal certificate'
              : null,
            typeNamesMissing: locales.slice(1),
            status: 'approved',
            issuerName: 'Halal Authority',
            expiryDate: '2027-05-01',
            coverage: { whole: true, variantIds: [] },
            rejectionReasonCode: null,
            lastChangedAt: T0.toString(),
            version: 3,
          },
        ],
      },
    });
    const keys = JSON.stringify(result)
      .match(/"[A-Za-z]+":/g)!
      .join(' ');
    expect(keys).not.toMatch(/number|cipher|document|note/i);
  });

  it('names the locales without a type name, all of them when the type has no names', async () => {
    products.byMarket.set(market.marketId, [
      row(market.marketId, { typeNames: {}, draft: source(null, null, [null]) }),
      row(market.marketId, {
        id: ID as Id<'ProductCertification'>,
        typeNames: Object.fromEntries(locales.map((locale) => [locale, 'Name'])),
        draft: source(null, null, [null]),
      }),
    ]);
    const result = await useCase().execute(contextOf('admin'), { productId: PRODUCT });
    expect(result.ok && result.value.items.map((item) => item.typeNamesMissing)).toEqual([
      locales,
      [],
    ]);
    expect(result.ok && result.value.items[0]!.typeName).toBeNull();
  });

  it('covers the whole product, or only the named variants', async () => {
    products.byMarket.set(market.marketId, [
      row(market.marketId, { draft: source(null, null, [null]) }),
      row(market.marketId, { draft: source(null, null, [VARIANT_1, VARIANT_2]) }),
    ]);
    const result = await useCase().execute(contextOf('admin'), { productId: PRODUCT });
    expect(result.ok && result.value.items.map((item) => item.coverage)).toEqual([
      { whole: true, variantIds: [] },
      { whole: false, variantIds: [VARIANT_1, VARIANT_2] },
    ]);
  });

  it('takes issuer, expiry and coverage from the approved revision, else the pending, else the draft', async () => {
    const approved = source('Approved Issuer', '2028-01-01', [VARIANT_1]);
    const pending = source('Pending Issuer', '2029-02-02', [VARIANT_2]);
    const draft = source('Draft Issuer', '2030-03-03', [null]);
    products.byMarket.set(market.marketId, [
      row(market.marketId, { approved, pending, draft }),
      row(market.marketId, { pending, draft }),
      row(market.marketId, { draft }),
      // A source that does not name the product is absent (null), so the next one speaks.
      row(market.marketId, { approved: null, pending: null, draft: null }),
    ]);
    const result = await useCase().execute(contextOf('admin'), { productId: PRODUCT });
    expect(
      result.ok &&
        result.value.items.map((item) => [item.issuerName, item.expiryDate, item.coverage]),
    ).toEqual([
      ['Approved Issuer', '2028-01-01', { whole: false, variantIds: [VARIANT_1] }],
      ['Pending Issuer', '2029-02-02', { whole: false, variantIds: [VARIANT_2] }],
      ['Draft Issuer', '2030-03-03', { whole: true, variantIds: [] }],
      [null, null, { whole: false, variantIds: [] }],
    ]);
  });

  it('shows the rejection reason code of the repository row', async () => {
    products.byMarket.set(market.marketId, [
      row(market.marketId, {
        status: 'rejected',
        rejectionReasonCode: 'document-unreadable',
        draft: source(null, null, [null]),
      }),
    ]);
    const result = await useCase().execute(contextOf('admin'), { productId: PRODUCT });
    expect(result.ok && result.value.items[0]!.rejectionReasonCode).toBe('document-unreadable');
  });

  it('is unavailable when the store fails', async () => {
    const failing = {
      forProduct: () => Promise.reject(new Error('down')),
    } as unknown as ProductCertificationRepository;
    expect(
      await useCase({ products: failing }).execute(contextOf('admin'), { productId: PRODUCT }),
    ).toEqual({ ok: false, error: { code: 'access.unavailable' } });
  });
});
