import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
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
import { Product } from '../../domain/product';
import { simpleProductType } from '../../domain/product-types/simple';
import type { WorkingCopy } from '../../domain/working-copy';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { PlatformProductRead } from './platform-product-read.use-case';

// `platform-product.read` shows the feature set the draft's primary category holds (A4 CAT-10),
// the same way the seller read does: the resolved one when it can be resolved, the stored one
// when there is no draft or the category cannot be resolved. Nothing is stored by a read.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('platform-product.read family in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
  );

  function rig(options: {
    copy: WorkingCopy | null;
    resolved: { ok: true; familyCode: string } | { ok: false; code: 'family.unavailable' };
    withResolver?: boolean;
  }) {
    const created = Product.create({
      id: ids.next<'Product'>(),
      marketId: code as MarketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'stored-family',
      productCode: 'P00000001',
      variantId: ids.next<'Variant'>(),
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const product = Product.restore({ ...created.value.state, version: 1 });
    const asked: (string | null)[] = [];
    const formFor: string[] = [];
    const resolver = {
      resolve: (_m: MarketContext, categoryId: string | null) => {
        asked.push(categoryId);
        return Promise.resolve(options.resolved);
      },
    } as unknown as ProductFamilyResolver;
    const useCase = new PlatformProductRead(gate, {
      unitOfWork: {
        run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
      } as unknown as UnitOfWork,
      products: { findById: () => Promise.resolve(product) } as unknown as ProductRepository,
      workingCopies: {
        find: () => Promise.resolve(options.copy),
      } as unknown as WorkingCopyRepository,
      revisions: { find: () => Promise.resolve(null) } as unknown as ProductRevisionRepository,
      ownReader: {
        productForm: (_m: MarketContext, family: string) => {
          formFor.push(family);
          return Promise.resolve({ fields: [], categories: [] });
        },
        offerTotalsOfProduct: () => Promise.resolve({ sellerCount: 0, offerCount: 0 }),
      } as unknown as OwnCatalogReader,
      policy: {
        taxCategoryCodes: () => ['gst'],
        maxVariantsPerProduct: () => 100,
        maxVariantAttributes: () => 2,
        locales: () => ({ default: 'en', supported: ['en'] }),
      } as unknown as CatalogMarketPolicy,
      ...(options.withResolver === false ? {} : { familyResolver: resolver }),
    });
    return { useCase, product, asked, formFor };
  }

  const copyOf = (categoryIds: unknown): WorkingCopy =>
    ({
      productId: 'x',
      content: { categoryIds },
      contentSchemaVersion: 1,
      baseRevisionId: null,
      lastSavedAt: T0,
      lastSavedByAccountId: 'a',
    }) as unknown as WorkingCopy;

  it("shows the feature set of the draft's primary category and builds the form from it", async () => {
    const { useCase, product, asked, formFor } = rig({
      copy: copyOf(['cat-1', 'cat-2']),
      resolved: { ok: true, familyCode: 'pantry' },
    });
    const result = await useCase.execute(context, { productId: product.state.id });
    expect(result.ok && result.value.familyCode).toBe('pantry');
    expect(asked).toEqual(['cat-1']);
    expect(formFor).toEqual(['pantry']);
  });

  it('keeps the stored feature set when it cannot be resolved, without a draft, or without a resolver', async () => {
    const unresolved = rig({
      copy: copyOf(['cat-1']),
      resolved: { ok: false, code: 'family.unavailable' },
    });
    const a = await unresolved.useCase.execute(context, { productId: unresolved.product.state.id });
    expect(a.ok && a.value.familyCode).toBe('stored-family');
    const noDraft = rig({ copy: null, resolved: { ok: true, familyCode: 'pantry' } });
    const b = await noDraft.useCase.execute(context, { productId: noDraft.product.state.id });
    expect(b.ok && b.value.familyCode).toBe('stored-family');
    expect(noDraft.asked).toEqual([]);
    const bare = rig({
      copy: copyOf([]),
      resolved: { ok: true, familyCode: 'pantry' },
      withResolver: false,
    });
    const c = await bare.useCase.execute(context, { productId: bare.product.state.id });
    expect(c.ok && c.value.familyCode).toBe('stored-family');
  });

  it('asks for the Market default when the draft has no category yet', async () => {
    const { useCase, product, asked } = rig({
      copy: copyOf([]),
      resolved: { ok: true, familyCode: 'default-for-market' },
    });
    const result = await useCase.execute(context, { productId: product.state.id });
    expect(result.ok && result.value.familyCode).toBe('default-for-market');
    expect(asked).toEqual([null]);
  });
});
