import type { TestingModuleBuilder } from '@nestjs/testing';
import type { MarketContext, Population } from '@mondapac/shared-kernel';
import {
  IDENTITY_MARKET_POLICY,
  type IdentityMarketPolicy,
} from '../../src/modules/identity/application/ports/identity-market-policy';
import {
  LINK_TARGETS,
  type LinkPage,
  type LinkTargets,
} from '../../src/modules/identity/application/ports/link-secrets';
import type { InvitationKind } from '../../src/modules/identity/domain/invitation';
import type { LinkPurpose } from '../../src/modules/identity/domain/one-time-link';
import type { ChallengePolicy } from '../../src/modules/identity/domain/sign-in-challenge';
import type { ThrottleRule } from '../../src/modules/identity/domain/throttle';
import { MarketConfigIdentityPolicy } from '../../src/modules/identity/infrastructure/market-config-identity-policy';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';

/**
 * The slice 7b values of the two fixture Markets (identity design 6.1, 6.6, 6.8), defined in
 * tests: the Market configuration and its validator belong to another track, which adds the keys
 * in the Market-config PR (the key list of the 7b report). AU holds Hassan's numbers; the
 * synthetic ZZ differs in every one, so nothing passes only for AU.
 */
export const ADMIN_MARKET_FIXTURE = Object.freeze({
  AU: {
    adminSession: { idleTimeoutSeconds: 30 * 60, absoluteLifetimeSeconds: 12 * 3600 },
    enrolLinkMinutes: 60,
    invitationMinutes: { admin: 72 * 60, 'seller-owner': 7 * 24 * 60, staff: 7 * 24 * 60 },
    challenge: { maxAttempts: 5, lifetimeSeconds: 300 },
    secondFactorThrottle: { limit: 10, windowMinutes: 24 * 60, blockMinutes: 24 * 60 },
    pages: {
      'sign-in': 'https://admin.au.mondapac.test/sign-in',
      'accept-invitation': 'https://admin.au.mondapac.test/accept-invitation',
      'enrol-second-factor': 'https://admin.au.mondapac.test/second-factor/enrol',
      'reset-password': 'https://admin.au.mondapac.test/reset-password',
    },
  },
  ZZ: {
    adminSession: { idleTimeoutSeconds: 20 * 60, absoluteLifetimeSeconds: 8 * 3600 },
    enrolLinkMinutes: 45,
    invitationMinutes: { admin: 48 * 60, 'seller-owner': 5 * 24 * 60, staff: 5 * 24 * 60 },
    challenge: { maxAttempts: 4, lifetimeSeconds: 240 },
    secondFactorThrottle: { limit: 8, windowMinutes: 48 * 60, blockMinutes: 48 * 60 },
    pages: {
      'sign-in': 'https://admin.zz.test/anmelden',
      'accept-invitation': 'https://admin.zz.test/einladung',
      'enrol-second-factor': 'https://admin.zz.test/zweiter-faktor',
      'reset-password': 'https://admin.zz.test/passwort',
    },
  },
} as const);

type FixtureMarket = keyof typeof ADMIN_MARKET_FIXTURE;

const fixtureOf = (market: MarketContext) => {
  const code = market.marketId as string;
  if (!Object.hasOwn(ADMIN_MARKET_FIXTURE, code)) return null;
  return ADMIN_MARKET_FIXTURE[code as FixtureMarket];
};

/**
 * The Market policy and link targets of the configuration, with the slice 7b values of
 * {@link ADMIN_MARKET_FIXTURE} for AU and ZZ in place of the keys the configuration lacks.
 * Every other read is the configuration's own.
 */
export function withAdminMarketFixture(
  base: IdentityMarketPolicy & LinkTargets,
): IdentityMarketPolicy & LinkTargets {
  return {
    passwordRules: (m) => base.passwordRules(m),
    existingAccountNoticeHours: (m) => base.existingAccountNoticeHours(m),
    sessionLifetime: (m: MarketContext, population: Population, keep?: boolean) => {
      if (population === 'admin') {
        const fixture = fixtureOf(m);
        return keep === true || fixture === null ? null : fixture.adminSession;
      }
      return base.sessionLifetime(m, population, keep);
    },
    sellerApprovalRequired: (m) => base.sellerApprovalRequired(m),
    signInThrottles: (m) => base.signInThrottles(m),
    mailThrottles: (m) => base.mailThrottles(m),
    signInRecordRetentionDays: (m) => base.signInRecordRetentionDays(m),
    linkLifetimeMinutes: (m: MarketContext, purpose: LinkPurpose) =>
      purpose === 'enrol-second-factor'
        ? (fixtureOf(m)?.enrolLinkMinutes ?? null)
        : base.linkLifetimeMinutes(m, purpose),
    unverifiedAccountRetentionDays: (m) => base.unverifiedAccountRetentionDays(m),
    mailSender: (m) => base.mailSender(m),
    invitationLifetimeMinutes: (m: MarketContext, kind: InvitationKind) =>
      fixtureOf(m)?.invitationMinutes[kind] ?? null,
    challengePolicy: (m: MarketContext): ChallengePolicy | null => fixtureOf(m)?.challenge ?? null,
    secondFactorThrottle: (m: MarketContext): ThrottleRule | null =>
      fixtureOf(m)?.secondFactorThrottle ?? null,
    target: <P extends Population>(m: MarketContext, population: P, page: LinkPage<P>) => {
      const fixture = fixtureOf(m);
      if (population === 'admin' && fixture !== null && Object.hasOwn(fixture.pages, page)) {
        return fixture.pages[page as keyof typeof fixture.pages];
      }
      return base.target(m, population, page);
    },
  };
}

/** {@link withAdminMarketFixture} over the configuration of `markets`. */
export function adminMarketPolicy(markets: MarketRegistry): IdentityMarketPolicy & LinkTargets {
  return withAdminMarketFixture(new MarketConfigIdentityPolicy(markets));
}

/** Binds {@link adminMarketPolicy} as identity's Market policy and link targets in a test app. */
export function overrideAdminMarketPolicy(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder
    .overrideProvider(IDENTITY_MARKET_POLICY)
    .useFactory({ factory: adminMarketPolicy, inject: [MarketRegistry] })
    .overrideProvider(LINK_TARGETS)
    .useFactory({ factory: adminMarketPolicy, inject: [MarketRegistry] });
}
