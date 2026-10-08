import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { MarketConfigIdentityPolicy } from './market-config-identity-policy';
import { pendingKeys } from './pending-market-keys';

// Slice 7b reads Market keys the validated schema does not hold yet (identity design 6.7, the 7a
// note "Needed for 7b"; the Market-config PR adds them). The reader answers null until a Market
// configures them, and refuses a value outside the guards as "not configured".

// Values of the two fixture Markets, defined here as the test's own fixtures: AU has Hassan's
// numbers; the synthetic ZZ differs in every one.
const SECTIONS = {
  AU: {
    invitations: { lifetimeMinutes: { admin: 4320, 'seller-owner': 10080, staff: 10080 } },
    challenges: { maxAttempts: 5, lifetimeSeconds: 300 },
    secondFactorThrottles: { account: { limit: 10, windowMinutes: 1440, blockMinutes: 1440 } },
  },
  ZZ: {
    invitations: { lifetimeMinutes: { admin: 2880, 'seller-owner': 7200, staff: 7200 } },
    challenges: { maxAttempts: 4, lifetimeSeconds: 240 },
    secondFactorThrottles: { account: { limit: 8, windowMinutes: 2880, blockMinutes: 2880 } },
  },
} as const;

describe.each(['AU', 'ZZ'] as const)('pendingKeys for market %s (slice 7b)', (code) => {
  const section = SECTIONS[code];

  it('reads every key of a configured section', () => {
    const keys = pendingKeys(section);
    expect(keys.invitationLifetimeMinutes('admin')).toBe(section.invitations.lifetimeMinutes.admin);
    expect(keys.invitationLifetimeMinutes('staff')).toBe(section.invitations.lifetimeMinutes.staff);
    expect(keys.challengePolicy()).toEqual(section.challenges);
    expect(keys.secondFactorThrottle()).toEqual(section.secondFactorThrottles.account);
  });

  it('answers null for a section without the keys (today, every Market)', () => {
    const keys = pendingKeys({ password: { minLength: 15 } });
    expect(keys.invitationLifetimeMinutes('admin')).toBeNull();
    expect(keys.challengePolicy()).toBeNull();
    expect(keys.secondFactorThrottle()).toBeNull();
    expect(pendingKeys(null).challengePolicy()).toBeNull();
  });

  it.each([
    [
      'an admin invitation longer than 72 hours (HF15)',
      { invitations: { lifetimeMinutes: { admin: 4321 } } },
    ],
    ['a zero lifetime', { invitations: { lifetimeMinutes: { admin: 0 } } }],
    ['a fractional lifetime', { invitations: { lifetimeMinutes: { admin: 60.5 } } }],
    ['a lifetime given as text', { invitations: { lifetimeMinutes: { admin: '4320' } } }],
  ])('refuses %s', (_, candidate) => {
    expect(pendingKeys(candidate).invitationLifetimeMinutes('admin')).toBeNull();
  });

  it.each([
    ['six attempts', { maxAttempts: 6, lifetimeSeconds: 300 }],
    ['a lifetime over five minutes', { maxAttempts: 5, lifetimeSeconds: 301 }],
    ['a missing lifetime', { maxAttempts: 5 }],
  ])('refuses a challenge policy with %s', (_, challenges) => {
    expect(pendingKeys({ challenges }).challengePolicy()).toBeNull();
  });

  it.each([
    ['more than ten failures', { limit: 11, windowMinutes: 1440, blockMinutes: 1440 }],
    ['a window under 24 hours', { limit: 10, windowMinutes: 1439, blockMinutes: 1440 }],
    ['no block (HF2: the block is the lock)', { limit: 10, windowMinutes: 1440, blockMinutes: 0 }],
  ])('refuses a second-factor throttle with %s', (_, account) => {
    expect(pendingKeys({ secondFactorThrottles: { account } }).secondFactorThrottle()).toBeNull();
  });

  it('ignores inherited properties', () => {
    const inherited: unknown = Object.create({
      challenges: { maxAttempts: 5, lifetimeSeconds: 300 },
    });
    expect(pendingKeys(inherited).challengePolicy()).toBeNull();
  });
});

describe('MarketConfigIdentityPolicy before the Market-config PR (fail closed)', () => {
  const policy = new MarketConfigIdentityPolicy(
    new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
  );

  it.each(['AU', 'ZZ'])('configures no admin value in %s yet', (code) => {
    const market = testMarketContext(code, 'default');
    expect(policy.sessionLifetime(market, 'admin')).toBeNull();
    expect(policy.linkLifetimeMinutes(market, 'enrol-second-factor')).toBeNull();
    expect(policy.invitationLifetimeMinutes(market, 'admin')).toBeNull();
    expect(policy.challengePolicy(market)).toBeNull();
    expect(policy.secondFactorThrottle(market)).toBeNull();
    for (const page of [
      'sign-in',
      'accept-invitation',
      'enrol-second-factor',
      'reset-password',
    ] as const) {
      expect(policy.target(market, 'admin', page)).toBeNull();
    }
  });
});
