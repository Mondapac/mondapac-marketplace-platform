import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  testMarketId,
} from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import {
  MarketNotHostedError,
  MarketRegistry,
} from '../../../platform/market-config/market-registry';
import { MarketConfigIdentityPolicy } from './market-config-identity-policy';

describe('MarketConfigIdentityPolicy (identity design 8.5)', () => {
  const registry = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const policy = new MarketConfigIdentityPolicy(registry);

  it('reads each Market its own password rules', () => {
    expect(policy.passwordRules(testMarketContext('AU', 'default'))).toEqual({
      minLength: 15,
      maxLength: 128,
    });
    expect(policy.passwordRules(testMarketContext('ZZ', 'default'))).toEqual({
      minLength: 16,
      maxLength: 100,
    });
  });

  it('refuses a Market this Region Stack does not host, with no fallback', () => {
    const onlyZz = new MarketConfigIdentityPolicy(
      new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, [testMarketId('ZZ')])),
    );

    expect(() => onlyZz.passwordRules(testMarketContext('AU', 'default'))).toThrow(
      MarketNotHostedError,
    );
  });
});
