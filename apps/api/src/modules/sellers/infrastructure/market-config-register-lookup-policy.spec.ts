import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { MarketConfigRegisterLookupPolicy } from './market-config-register-lookup-policy';
import {
  UnknownRegisterLookupAdapterError,
  availableRegisterAdapterCodes,
} from './register-lookups';

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
    let thrown: unknown;
    try {
      new MarketConfigRegisterLookupPolicy(registryHosting(TEST_MARKET_IDS), new Set<string>());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnknownRegisterLookupAdapterError);
    expect(thrown).toMatchObject({ marketId: synthetic, adapter: 'fake' });
  });

  it.each([
    ['production, even when set explicitly', { nodeEnv: 'production', nodeEnvExplicit: true }],
    ['development that was not set explicitly', { nodeEnv: 'development', nodeEnvExplicit: false }],
    ['test that was not set explicitly', { nodeEnv: 'test', nodeEnvExplicit: false }],
  ] as const)('never starts a Market that names the fake in %s', (_name, environment) => {
    const available = availableRegisterAdapterCodes(environment);

    expect(available.has('fake')).toBe(false);
    expect(
      () => new MarketConfigRegisterLookupPolicy(registryHosting([synthetic]), available),
    ).toThrow(UnknownRegisterLookupAdapterError);
  });

  it('has the fake only on an explicit development or test start', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(availableRegisterAdapterCodes({ nodeEnv, nodeEnvExplicit: true }).has('fake')).toBe(
        true,
      );
    }
  });

  it('gives a hosted Market with no sellers section no register', () => {
    const bare = new Map(
      [...configs].map(([id, config]) => [id, { ...config, sellers: undefined }]),
    );
    const policy = new MarketConfigRegisterLookupPolicy(new MarketRegistry(bare), new Set());

    expect(policy.settingsOf(testMarketContext(synthetic, 'default'))).toEqual({ kind: 'none' });
  });

  it('does not check a Market this Region Stack does not host, and refuses its context', () => {
    const policy = new MarketConfigRegisterLookupPolicy(
      registryHosting([launch]),
      new Set<string>(),
    );

    expect(() => policy.settingsOf(testMarketContext(synthetic, 'default'))).toThrow(/not hosted/);
  });
});
