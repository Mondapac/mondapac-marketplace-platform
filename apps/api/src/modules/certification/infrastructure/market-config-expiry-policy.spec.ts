import { parseMarketId, type MarketId } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  assertCertificationConfigured,
  CertificationMarketConfigError,
  manufacturerBasisEnabledIn,
  MarketConfigExpiryPolicy,
} from './market-config-expiry-policy';

// The `certification` section of the Market files (design 5.1; Ali ruling 2026-10-17 on ADR-0003
// decision 5): read for AU from config/markets and for ZZ from the test fixture; a hosted Market
// without it, or with an unusable one, stops the start-up. No null policy, no default.

const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
const idOf = (code: string): MarketId => {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error(`${code} must parse`);
  return parsed.value;
};

describe('the certification section of the Market configuration', () => {
  it('gives AU 30, 14, 1 and 7 and ZZ its own submit-by days', () => {
    const policies = new MarketConfigExpiryPolicy(new MarketRegistry(configs));
    expect(policies.policyFor(testMarketContext('AU', 'default'))).toEqual({
      warningThresholdsDays: [30, 14, 1],
      renewalSubmitByDays: 7,
    });
    expect(policies.policyFor(testMarketContext('ZZ', 'default'))).toEqual({
      warningThresholdsDays: [30, 14, 1],
      renewalSubmitByDays: 2,
    });
  });

  it('accepts a Region Stack whose hosted Markets all have the section', () => {
    expect(() => assertCertificationConfigured(new MarketRegistry(configs))).not.toThrow();
  });

  it.each(['AU', 'ZZ'])('stops the start-up when hosted Market %s has none, naming it', (code) => {
    const without = new Map(configs);
    without.set(idOf(code), { ...configs.get(idOf(code))!, certification: undefined });
    const registry = new MarketRegistry(without);
    expect(() => assertCertificationConfigured(registry)).toThrow(CertificationMarketConfigError);
    expect(() => assertCertificationConfigured(registry)).toThrow(new RegExp(code));
    expect(() =>
      new MarketConfigExpiryPolicy(registry).policyFor(testMarketContext(code, 'default')),
    ).toThrow(CertificationMarketConfigError);
  });

  it.each(['AU', 'ZZ'])('stops the start-up when %s has an unusable section', (code) => {
    const bad = new Map(configs);
    bad.set(idOf(code), {
      ...configs.get(idOf(code))!,
      certification: {
        expiryWarningThresholdsDays: [14, 14],
        renewalSubmitByDays: 7,
        manufacturerBasisEnabled: false,
      },
    });
    expect(() => assertCertificationConfigured(new MarketRegistry(bad))).toThrow(
      CertificationMarketConfigError,
    );
  });
});

describe('the manufacturer-basis switch of the Market configuration (slice 14)', () => {
  it('is off for AU and on for the synthetic Market', () => {
    const registry = new MarketRegistry(configs);
    expect(manufacturerBasisEnabledIn(registry, idOf('AU'))).toBe(false);
    expect(manufacturerBasisEnabledIn(registry, idOf('ZZ'))).toBe(true);
  });

  it.each(['AU', 'ZZ'])('is off for %s without the section (fail closed)', (code) => {
    const without = new Map(configs);
    without.set(idOf(code), { ...configs.get(idOf(code))!, certification: undefined });
    expect(manufacturerBasisEnabledIn(new MarketRegistry(without), idOf(code))).toBe(false);
  });

  it('is off for a Market the Region Stack does not host', () => {
    expect(manufacturerBasisEnabledIn(new MarketRegistry(configs), idOf('NZ'))).toBe(false);
  });
});
