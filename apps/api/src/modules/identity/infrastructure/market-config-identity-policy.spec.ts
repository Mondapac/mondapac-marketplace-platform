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

  it('reads each Market its own notice interval', () => {
    expect(policy.existingAccountNoticeHours(testMarketContext('AU', 'default'))).toBe(24);
    expect(policy.existingAccountNoticeHours(testMarketContext('ZZ', 'default'))).toBe(12);
  });

  it('reads each Market its own customer session lifetime, in seconds, and none for others', () => {
    expect(policy.sessionLifetime(testMarketContext('AU', 'default'), 'customer')).toEqual({
      idleTimeoutSeconds: 14 * 86_400,
      absoluteLifetimeSeconds: 30 * 86_400,
    });
    expect(policy.sessionLifetime(testMarketContext('ZZ', 'default'), 'customer')).toEqual({
      idleTimeoutSeconds: 7 * 86_400,
      absoluteLifetimeSeconds: 14 * 86_400,
    });
    expect(policy.sessionLifetime(testMarketContext('AU', 'default'), 'seller')).toBeNull();
    expect(policy.sessionLifetime(testMarketContext('ZZ', 'default'), 'admin')).toBeNull();
  });

  it('reads each Market its own throttles and retention (identity design 6.8, H3)', () => {
    const au = testMarketContext('AU', 'default');
    const zz = testMarketContext('ZZ', 'default');

    expect(policy.signInThrottles(au).accountOrigin).toEqual({
      limit: 5,
      windowMinutes: 15,
      blockMinutes: 15,
    });
    expect(policy.signInThrottles(zz).accountOrigin).toEqual({
      limit: 4,
      windowMinutes: 10,
      blockMinutes: 20,
    });
    expect(policy.mailThrottles(au).account.limit).toBe(3);
    expect(policy.mailThrottles(zz).account.limit).toBe(2);
    expect(policy.signInRecordRetentionDays(au)).toBe(90);
    expect(policy.signInRecordRetentionDays(zz)).toBe(60);
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
