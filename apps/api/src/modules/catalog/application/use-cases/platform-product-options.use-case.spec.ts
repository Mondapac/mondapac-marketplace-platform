import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
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
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import { PlatformProductOptions } from './platform-product-options.use-case';

// `platform-product.options` gives the Add page everything it needs before a product exists: the
// Market's types, locales and tax categories, and the active platform categories.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const POLICY: Readonly<
  Record<
    string,
    { types: string[]; tax: string[]; locales: { default: string; supported: string[] } }
  >
> = {
  AU: {
    types: ['simple', 'configurable'],
    tax: ['gst', 'gst-free'],
    locales: { default: 'en', supported: ['en'] },
  },
  ZZ: { types: ['simple'], tax: ['vat-20'], locales: { default: 'de', supported: ['de', 'en'] } },
};

describe.each(['AU', 'ZZ'] as const)('platform-product.options in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(
    new FixedClock(Temporal.Instant.from('2026-11-07T00:00:00Z')),
  );
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
  );
  const categories = [
    { categoryId: `c-${code}-1`, parentId: null, names: { en: 'Pantry' } },
    { categoryId: `c-${code}-2`, parentId: `c-${code}-1`, names: { en: 'Rice' } },
  ];

  function rig(failure?: 'policy' | 'unit') {
    const asked: string[] = [];
    const flags: boolean[] = [];
    const useCase = new PlatformProductOptions(gate, {
      unitOfWork: {
        run: async <T, E>(
          _m: MarketContext,
          work: () => Promise<Result<T, E>>,
          opts?: { readOnly?: boolean },
        ) => {
          flags.push(opts?.readOnly === true);
          return failure === 'unit' ? { ok: false, error: { code: 'unavailable' } } : work();
        },
      } as unknown as UnitOfWork,
      ownReader: {
        productCategories: (m: MarketContext) => {
          asked.push(m.marketId);
          return Promise.resolve(categories);
        },
      } as unknown as OwnCatalogReader,
      policy: {
        productTypes: () => POLICY[code]!.types,
        taxCategoryCodes: () => {
          if (failure === 'policy') throw new Error('no config');
          return POLICY[code]!.tax;
        },
        locales: () => POLICY[code]!.locales,
      } as unknown as CatalogMarketPolicy,
    });
    return { useCase, asked, flags };
  }

  it("answers the Market's types, locales, tax categories and the active categories", async () => {
    const { useCase, asked, flags } = rig();
    const result = await useCase.execute(context, {});
    expect(result.ok && result.value).toEqual({
      productTypes: POLICY[code]!.types,
      locales: POLICY[code]!.locales,
      taxCategoryCodes: POLICY[code]!.tax,
      categories,
    });
    expect(asked).toEqual([code]);
    expect(flags).toEqual([true]);
  });

  it('is unavailable when the Market configuration fails', async () => {
    const result = await rig('policy').useCase.execute(context, {});
    expect(!result.ok && result.error.code).toBe('access.unavailable');
  });

  it('degrades to no categories when the category read fails, keeping the rest', async () => {
    const result = await rig('unit').useCase.execute(context, {});
    expect(result.ok && result.value).toEqual({
      productTypes: POLICY[code]!.types,
      locales: POLICY[code]!.locales,
      taxCategoryCodes: POLICY[code]!.tax,
      categories: [],
    });
  });
});
