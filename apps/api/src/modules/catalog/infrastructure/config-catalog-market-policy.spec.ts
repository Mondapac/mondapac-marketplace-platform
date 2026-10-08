import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { CatalogNotConfiguredError } from '../application/ports/catalog-market-policy';
import { ConfigCatalogMarketPolicy } from './config-catalog-market-policy';

// The catalog's Market settings for both fixtures (catalog design 7.1): they differ, and a Market
// without the section is refused, never answered with a default.

const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
const policy = new ConfigCatalogMarketPolicy(new MarketRegistry(configs));
const au = testMarketContext('AU', 'default');
const zz = testMarketContext('ZZ', 'default');

describe('ConfigCatalogMarketPolicy', () => {
  it('answers each Market from its own file', async () => {
    expect(policy.maxVariantsPerProduct(au)).toBe(100);
    expect(policy.maxVariantsPerProduct(zz)).toBe(3);
    await expect(policy.approvalRequired(au)).resolves.toBe(true);
    await expect(policy.approvalRequired(zz)).resolves.toBe(false);
    expect(policy.taxCategoryCodes(au)).toEqual(['taxable', 'gst_free']);
    expect(policy.taxCategoryCodes(zz)).toEqual(['zz_standard', 'zz_reduced', 'zz_zero']);
  });

  it('gives the product types and the default family of each Market', () => {
    expect(policy.productTypes(au)).toEqual(['simple', 'configurable']);
    expect(policy.productTypes(zz)).toEqual(['simple']);
    expect(policy.defaultFamily(au)).toBe('default');
    expect(policy.defaultFamily(zz)).toBe('default');
  });

  it('gives the sensitive-change flags of the Market', () => {
    expect(policy.sensitiveChanges(au)).toMatchObject({ platformCategories: true, name: true });
    expect(policy.sensitiveChanges(zz)).toMatchObject({
      platformCategories: false,
      taxCategory: true,
      name: true,
      primaryImage: false,
      variantRemoved: false,
    });
  });

  it('hands out a copy, so a caller cannot change the Market file in memory', () => {
    const first = policy.sensitiveChanges(au) as { name: boolean };
    first.name = false;
    expect(policy.sensitiveChanges(au).name).toBe(true);
  });

  it('refuses a Market that has no catalog section', async () => {
    const [auConfig] = [configs.get(au.marketId)!];
    const bare = new MarketRegistry(new Map([[au.marketId, { ...auConfig, catalog: undefined }]]));
    const unconfigured = new ConfigCatalogMarketPolicy(bare);

    expect(() => unconfigured.maxVariantsPerProduct(au)).toThrow(CatalogNotConfiguredError);
    await expect(unconfigured.approvalRequired(au)).rejects.toBeInstanceOf(
      CatalogNotConfiguredError,
    );
  });
});
