import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { MarketConfigRegisterLookupPolicy } from './market-config-register-lookup-policy';
import { UnknownRegisterLookupAdapterError } from './register-lookups';

// The Market-configured register-lookup values and the start-up check (sellers design 4.1, 4.2;
// Hassan L3). Both Market fixtures are loaded from their files.

const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

function registryHosting(hosted: readonly string[]): MarketRegistry {
  return new MarketRegistry(new Map([...configs].filter(([id]) => hosted.includes(id))));
}

describe('MarketConfigRegisterLookupPolicy', () => {
  const launch = 'AU';
  const synthetic = 'ZZ';

  it('answers each Market its own values, and `none` for the Market whose adapter is none', () => {
    const policy = new MarketConfigRegisterLookupPolicy(
      registryHosting(TEST_MARKET_IDS),
      new Set(['fake']),
    );

    expect(policy.settingsOf(testMarketContext(launch, 'default'))).toEqual({ kind: 'none' });
    expect(policy.settingsOf(testMarketContext(synthetic, 'default'))).toMatchObject({
      kind: 'configured',
      adapter: 'fake',
      maxResultAgeDays: 7,
      perAccountLimit: 2,
    });
  });

  it('refuses to start when a hosted Market names an adapter this environment lacks', () => {
    expect(
      () =>
        new MarketConfigRegisterLookupPolicy(registryHosting(TEST_MARKET_IDS), new Set<string>()),
    ).toThrow(UnknownRegisterLookupAdapterError);
  });

  it('does not check a Market this Region Stack does not host, and refuses its context', () => {
    const policy = new MarketConfigRegisterLookupPolicy(
      registryHosting([launch]),
      new Set<string>(),
    );

    expect(() => policy.settingsOf(testMarketContext(synthetic, 'default'))).toThrow();
  });
});
