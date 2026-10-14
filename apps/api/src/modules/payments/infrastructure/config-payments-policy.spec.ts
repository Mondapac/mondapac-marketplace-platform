import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ConfigPaymentsPolicy } from './config-payments-policy';

const policy = new ConfigPaymentsPolicy(
  new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
);

describe('ConfigPaymentsPolicy', () => {
  it.each([
    ['AU', 'AU'],
    ['ZZ', 'JP'],
  ])('reads the country of connected accounts of market %s from its config', (code, country) => {
    expect(policy.connectedAccountCountry(testMarketContext(code, 'default'))).toBe(country);
  });

  it.each(['AU', 'ZZ'])(
    'builds the onboarding pages of market %s from the seller panel origin only',
    (code) => {
      const urls = policy.onboardingUrls(testMarketContext(code, 'default'));
      expect(urls).not.toBeNull();
      const returned = new URL(urls!.returnUrl);
      const refresh = new URL(urls!.refreshUrl);
      expect(returned.protocol).toBe('https:');
      expect(returned.origin).toBe(refresh.origin);
      expect(returned.pathname).toBe('/payout-account');
      expect(returned.search).toBe('?stripe=return');
      expect(refresh.search).toBe('?stripe=refresh');
    },
  );
});
