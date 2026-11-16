import type { MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { OwnCatalogReader, ProductFormCategory } from '../ports/own-catalog.reader';
import { OwnProductOptions } from './own-product-options.use-case';

// The seller's product form options on both Market fixtures: the tax categories and the platform
// categories come from the Market, before any product exists.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const clock = new FixedClock(Temporal.Instant.from('2026-11-16T00:00:00Z'));
const ids = new SequenceIdGenerator(clock);
const unitOfWork = {
  run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
} as unknown as UnitOfWork;

describe.each(['AU', 'ZZ'] as const)('own-product.options in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const sellerId = ids.next<'Seller'>();
  const context = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId,
    }),
  );
  const categories: ProductFormCategory[] = [
    { categoryId: `${code}-1`, parentId: null, names: { en: `Pantry ${code}` } },
  ];
  const asked: string[] = [];
  const ownReader = {
    productCategories: (m: MarketContext) => {
      asked.push(m.marketId);
      return Promise.resolve(categories);
    },
  } as unknown as OwnCatalogReader;
  const allowedTypes: AllowedProductTypesReader = { allowedFor: () => Promise.resolve('all') };

  it('lists the Market tax categories and the platform categories, as the product read does', async () => {
    const result = await new OwnProductOptions(gate, {
      policy,
      allowedTypes,
      unitOfWork,
      ownReader,
    }).execute(context, {});
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.taxCategoryCodes).toEqual([...policy.taxCategoryCodes(market)]);
    expect(result.value.taxCategoryCodes.length).toBeGreaterThan(0);
    expect(result.value.categories).toEqual(categories);
    expect(asked).toContain(market.marketId);
  });

  it('answers an empty category list, keeping the rest, when the category read fails', async () => {
    const failing = {
      run: () => Promise.resolve({ ok: false, error: { code: 'unit.failed' } }),
    } as unknown as UnitOfWork;
    const result = await new OwnProductOptions(gate, {
      policy,
      allowedTypes,
      unitOfWork: failing,
      ownReader,
    }).execute(context, {});
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.categories).toEqual([]);
    expect(result.value.taxCategoryCodes).toEqual([...policy.taxCategoryCodes(market)]);
    expect(result.value.productTypes.length).toBeGreaterThan(0);
  });

  it('answers an empty category list when the reader throws', async () => {
    const throwing = {
      productCategories: () => Promise.reject(new Error('db down')),
    } as unknown as OwnCatalogReader;
    const result = await new OwnProductOptions(gate, {
      policy,
      allowedTypes,
      unitOfWork,
      ownReader: throwing,
    }).execute(context, {});
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.categories).toEqual([]);
  });
});
