import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import { err } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryAttributeAdminReader } from '../../../../../test/support/catalog-attribute-admin-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { FeatureSetRecord } from '../ports/attribute-admin.reader';
import type { SheetWriter } from '../ports/sheet-writer';
import { PlatformImportTemplate } from './platform-import-template.use-case';

// The product import template with a feature set (attributes package A9), on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const ADMIN = '01990000-0000-7000-8000-0000000000a1';

const entry = (code: string) => ({ code, required: false, isVariantOption: false });
const set = (code: string, groups: readonly (readonly string[])[]): FeatureSetRecord =>
  ({
    id: `fs-${code}` as never,
    code,
    status: 'active',
    createdByKind: 'admin',
    createdAt: undefined as never,
    revisionNo: 1,
    version: 1,
    names: {},
    groups: groups.map((codes, index) => ({
      groupCode: `g${index}`,
      attributes: codes.map(entry),
    })),
  }) as unknown as FeatureSetRecord;

describe.each(['AU', 'ZZ'] as const)('platform import template in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN as never,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId:
          population === 'seller' ? ('01990000-0000-7000-8000-0000000000a3' as never) : null,
      }),
    );
  const allow: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
  const unitOfWork = {
    run: async <T>(_m: MarketContext, work: () => Promise<T>) => work(),
  } as unknown as UnitOfWork;
  const sheetWriter: SheetWriter = {
    xlsx: async function* (_name, rows) {
      for await (const row of rows) yield new TextEncoder().encode(row.join('\t') + '\n');
    },
  };

  const build = () => {
    const reader = new MemoryAttributeAdminReader();
    reader.seedFeatureSet(
      market.marketId,
      set('meat', [
        ['brand', 'cut', 'pack-size'],
        ['cut', 'gtin', 'organic', 'net_weight', 'halal-status', 'price-tag'],
      ]),
    );
    reader.seedFeatureSet(market.marketId, { ...set('old', [['cut']]), status: 'archived' });
    const useCase = new PlatformImportTemplate(createUseCaseGate(markets, allow), {
      unitOfWork,
      attributeAdminReader: reader,
      policy: new ConfigCatalogMarketPolicy(markets),
      sheetWriter,
    });
    return { useCase };
  };

  it('has no attribute column without a feature set', async () => {
    const result = await build().useCase.execute(context(), {});
    expect(result.ok && result.value.attributeColumns).toEqual([]);
    expect(result.ok && result.value.csv.split('\n')[0]).not.toContain('attr[');
  });

  it('adds an attr[<code>] column for each attribute of the feature set, once, in order', async () => {
    const result = await build().useCase.execute(context(), { featureSet: 'meat' });
    expect(result.ok && result.value.attributeColumns).toEqual([
      'attr[cut]',
      'attr[pack-size]',
      'attr[organic]',
      'attr[net_weight]',
    ]);
    if (!result.ok) throw new Error('template');
    const header = result.value.csv.split(/\r?\n/)[0]!;
    expect(header.endsWith('attr[cut],attr[pack-size],attr[organic],attr[net_weight]')).toBe(true);
    expect(result.value.xlsx.length).toBeGreaterThan(0);
  });

  it('answers feature-set.unknown for a code the Market does not have, and validates the code', async () => {
    const { useCase } = build();
    expect(await useCase.execute(context(), { featureSet: 'poultry' })).toEqual(
      err({ code: 'feature-set.unknown' }),
    );
    // An archived feature set is not one a category can hold.
    expect(await useCase.execute(context(), { featureSet: 'old' })).toEqual(
      err({ code: 'feature-set.unknown' }),
    );
    expect(await useCase.execute(context(), { featureSet: 'Bad Code' })).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'featureSet', code: 'format' }] }),
    );
  });

  it('is for admins only', async () => {
    const result = await build().useCase.execute(context('seller'), { featureSet: 'meat' });
    expect(result).toEqual(err({ code: 'access.denied' }));
  });
});
