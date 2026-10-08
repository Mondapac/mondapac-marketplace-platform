import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  realEffectiveKeys,
  realPermissionRegistry,
} from '../../../../../test/support/permission-registry';
import {
  TEST_LOCALE_CONFIG_DIRS,
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type {
  ConsumedEnvelope,
  SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import { loadLocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import { RandomLinkTokens } from '../../infrastructure/links/random-link-tokens';
import { CatalogueMailComposer } from '../../infrastructure/mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import {
  checkRoleSeed,
  CheckedInRoleSeed,
  RoleSeedError,
} from '../../infrastructure/seed/checked-in-role-seed';
import { RandomSessionTokens } from '../../infrastructure/sessions/random-session-tokens';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { SeededRole } from '../ports/role-seed';
import { checkRoleSeedKeys } from '../roles/role-seed-keys';
import type { ThrottleKeys } from '../ports/session-secrets';
import { ConfirmSellerEmail } from './confirm-seller-email.use-case';
import { DescribeSellerStatus } from './describe-seller-status.use-case';
import { ListRegisteredSellers } from './list-registered-sellers.use-case';
import { MembershipOf } from './membership-of.use-case';
import { PurgeUnverifiedAccounts } from './purge-unverified-accounts.use-case';
import { RegisterSeller } from './register-seller.use-case';
import { RequestSellerVerification } from './request-seller-verification.use-case';
import { SeedRoles } from './seed-roles.use-case';
import { SellerAccessOf } from './seller-access-of.use-case';
import { SellerAccessOfSystem } from './seller-access-of-system.use-case';
import { identityMailSubscriptions } from '../../presentation/subscribers/mail.subscriptions';
import { SendExistingAccountMail } from './send-existing-account-mail.use-case';
import { SendLinkMail } from './send-link-mail.use-case';
import { SendPasswordChangedMail } from './send-password-changed-mail.use-case';
import { SendWelcomeMail } from './send-welcome-mail.use-case';
import { SignInSeller } from './sign-in-seller.use-case';

// Identity slice 5 in memory (identity design 3.1, 3.3, 5.2, 5.5, 5.6, 6.1, 6.3, 6.7, 8.1, 8.2;
// SEL-01 to SEL-04): the system-role seed, seller self-registration with its founding rows, the
// link mail and the confirmation that records `seller-registered`, limited sign-in, the facade
// reads, the welcome mail and the purge. Both Market fixtures with their own configuration (AU:
// approval required, seller sessions 12 h / 24 h, kept 14 d / 30 d; ZZ: no approval, 10 h /
// 20 h, kept 7 d / 14 d) and locales. PostgreSQL behaviour is covered by test/db/.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Owner@Example.com';
const NAME = 'Amina Rahman';
const ORIGIN = '203.0.113.9';
const CLIENT = { origin: ORIGIN, address: ORIGIN };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};

function setUp() {
  const fakes = new IdentityFakes();
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const units: (UnitOfWorkOptions | undefined)[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(
      m: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push(options);
      return fakes.unitOfWork.run(m, work);
    },
    runOnce: (m, delivery, work, options) => fakes.unitOfWork.runOnce(m, delivery, work, options),
  };
  const gate = createUseCaseGate(
    markets,
    new AccountAuthorisationCheck({
      unitOfWork,
      accounts: fakes.accountRepository,
      memberships: fakes.membershipRepository,
      sellerAccess: fakes.sellerAccessRepository,
      grants: fakes.grantReader,
      effectiveKeys: realEffectiveKeys(),
    }),
  );
  const linkTokens = new RandomLinkTokens();
  const common = {
    unitOfWork,
    accounts: fakes.accountRepository,
    links: fakes.linkRepository,
    throttles: fakes.throttleRepository,
    keys,
    outbox: fakes.outbox,
    policy,
    clock,
    ids,
  };
  const signInDeps = {
    ...common,
    sessions: fakes.sessionRepository,
    records: fakes.recordRepository,
    hasher: fakes.hasher,
    tokens: new RandomSessionTokens(),
    memberships: fakes.membershipRepository,
    sellerAccess: fakes.sellerAccessRepository,
  };
  const mailDeps = {
    unitOfWork,
    accounts: fakes.accountRepository,
    targets: policy,
    composer,
    transport: fakes.mailTransport,
    policy,
  };
  const sendLinkMail = new SendLinkMail(gate, {
    ...mailDeps,
    links: fakes.linkRepository,
    linkTokens,
    clock,
  });
  const welcome = new SendWelcomeMail(gate, mailDeps);
  return {
    fakes,
    clock,
    units,
    /** Identity's mail subscriptions, as the module registers them (identity design 9). */
    subscriptions: identityMailSubscriptions(
      sendLinkMail,
      new SendExistingAccountMail(gate, mailDeps),
      welcome,
      new SendPasswordChangedMail(gate, mailDeps),
    ),
    seed: new SeedRoles(gate, {
      unitOfWork,
      roles: fakes.roleRepository,
      seed: new CheckedInRoleSeed(),
      permissions: realPermissionRegistry(),
      clock,
      ids,
      audit: fakes.audit,
    }),
    register: new RegisterSeller(gate, {
      ...common,
      sellerAccess: fakes.sellerAccessRepository,
      memberships: fakes.membershipRepository,
      roles: fakes.roleRepository,
      assignments: fakes.assignmentRepository,
      hasher: fakes.hasher,
      commonPasswords: { isCommon: () => false },
    }),
    resend: new RequestSellerVerification(gate, common),
    sendLinkMail,
    confirm: new ConfirmSellerEmail(gate, {
      ...signInDeps,
      linkTokens,
      audit: fakes.audit,
      assignments: fakes.assignmentRepository,
    }),
    signIn: new SignInSeller(gate, signInDeps),
    status: new DescribeSellerStatus(gate, {
      unitOfWork,
      accounts: fakes.accountRepository,
      sellerAccess: fakes.sellerAccessRepository,
    }),
    membershipOf: new MembershipOf(gate, {
      unitOfWork,
      memberships: fakes.membershipRepository,
      assignments: fakes.assignmentRepository,
    }),
    accessOf: new SellerAccessOf(gate, { unitOfWork, sellerAccess: fakes.sellerAccessRepository }),
    accessOfSystem: new SellerAccessOfSystem(gate, {
      unitOfWork,
      sellerAccess: fakes.sellerAccessRepository,
    }),
    list: new ListRegisteredSellers(gate, {
      unitOfWork,
      sellerAccess: fakes.sellerAccessRepository,
    }),
    welcome,
    purge: new PurgeUnverifiedAccounts(gate, {
      unitOfWork,
      accounts: fakes.accountRepository,
      memberships: fakes.membershipRepository,
      assignments: fakes.assignmentRepository,
      sellerAccess: fakes.sellerAccessRepository,
      policy,
      clock,
    }),
  };
}

type Setup = ReturnType<typeof setUp>;

let deliveries = 0;
function deliveryOf(subscriber: string): EventDelivery {
  deliveries += 1;
  return {
    eventId: `0199eeee-0000-7000-8000-${String(deliveries).padStart(12, '0')}` as Id<'event'>,
    subscriber,
    attempt: 1,
  };
}

/** The token in the fragment of a mailed link. */
const tokenOf = (text: string): string => /#(ml1_[A-Za-z0-9_-]{43})/.exec(text)![1]!;

describe('the checked-in role seed (identity design 5.6)', () => {
  const role = (overrides: Partial<SeededRole>): SeededRole => ({
    scope: 'seller',
    kind: 'system',
    seedCode: 'seller-owner',
    seedVersion: 1,
    nameKey: 'identity.role.seller-owner',
    permissionKeys: [],
    ...overrides,
  });
  const platform = role({ scope: 'platform', seedCode: 'platform-administrator' });

  it('holds one system role per scope with no keys, and the default roles of 5.6 (slice 8a-1)', () => {
    expect(
      new CheckedInRoleSeed()
        .roles()
        .map((r) => [r.scope, r.kind, r.seedCode, r.permissionKeys.length]),
    ).toEqual([
      ['platform', 'system', 'platform-administrator', 0],
      ['platform', 'default', 'onboarding-compliance', 4],
      ['platform', 'default', 'catalogue-moderator', 1],
      ['platform', 'default', 'operations-support', 4],
      ['platform', 'default', 'finance', 1],
      ['platform', 'default', 'viewer', 4],
      ['seller', 'system', 'seller-owner', 0],
      ['seller', 'default', 'store-manager', 2],
      ['seller', 'default', 'order-fulfilment', 0],
      ['seller', 'default', 'catalogue-stock', 0],
      ['seller', 'default', 'customer-service', 0],
      ['seller', 'default', 'bookkeeper', 0],
    ]);
  });

  it("its keys agree with the real registry: declared, in the role's scope, never protected", () => {
    expect(() =>
      checkRoleSeedKeys(new CheckedInRoleSeed().roles(), realPermissionRegistry()),
    ).not.toThrow();
  });

  it.each<[string, SeededRole[]]>([
    ['a malformed code', [platform, role({ seedCode: 'Seller Owner' })]],
    ['a version below 1', [platform, role({ seedVersion: 0 })]],
    ['a duplicate code', [platform, role({}), role({})]],
    ['a system role with keys', [platform, role({ permissionKeys: ['catalog.offer.edit'] })]],
    ['two system roles in a scope', [platform, role({}), role({ seedCode: 'seller-boss' })]],
    ['a custom role', [platform, role({}), role({ kind: 'custom' as never, seedCode: 'x' })]],
    [
      'a key listed twice',
      [
        platform,
        role({}),
        role({
          kind: 'default',
          seedCode: 'store-manager',
          permissionKeys: ['identity.team-member.view', 'identity.team-member.view'],
        }),
      ],
    ],
    ['a scope without a system role', [platform]],
  ])('refuses %s', (_case, roles) => {
    expect(() => checkRoleSeed(roles)).toThrow(RoleSeedError);
  });
});

describe.each(TEST_MARKETS)('seller account and limited sign-in in market %s (slice 5)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const anonymous = testCallContext(market, 'anonymous', 'seller-test-0001');
  const system = testCallContext(market, 'system', 'seller-test-0002');
  const approvalRequired = policy.sellerApprovalRequired(market);
  const expectedState: 'pending' | 'approved' = approvalRequired ? 'pending' : 'approved';
  const sessionLifetime = policy.sessionLifetime(market, 'seller')!;
  const keptLifetime = policy.sessionLifetime(market, 'seller', true)!;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const account = (s: Setup): AccountState =>
    [...s.fakes.accounts.values()].find((a) => a.population === 'seller')!;
  const sellerOf = (s: Setup) => [...s.fakes.sellerAccess.values()][0]!;
  const actorOf = (s: Setup, sellerId: Id<'Seller'> | null = sellerOf(s).sellerId) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: account(s).id,
        sessionId: '01990000-0000-7000-8000-00000000a001' as Id<'Session'>,
        sellerId,
      }),
    );

  async function signUp(s: Setup, email = EMAIL) {
    const result = await s.register.execute(anonymous, {
      displayName: NAME,
      email,
      password: PASSWORD,
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: true, value: { code: 'sign-up.accepted' } });
  }

  /** Runs the link-mail handler for the latest link request; answers the mailed token. */
  async function mailedToken(s: Setup): Promise<string> {
    const event = s.fakes.events
      .filter((e) => e.type === 'identity.one-time-link-requested.v1')
      .at(-1)!;
    const payload = event.payload as { linkId: Id; accountId: Id; purpose: 'verify-email' };
    await s.sendLinkMail.execute(system, {
      delivery: deliveryOf('identity.link-mail'),
      linkId: payload.linkId,
      accountId: payload.accountId,
      purpose: payload.purpose,
      aggregateVersion: event.aggregateVersion,
    });
    return tokenOf(s.fakes.mails.at(-1)!.text);
  }

  /** Seeds the roles, signs up and confirms: a registered seller with its owner signed in. */
  async function registered(s: Setup) {
    await s.seed.execute(system, {});
    await signUp(s);
    const token = await mailedToken(s);
    const confirmed = await s.confirm.execute(anonymous, {
      token,
      password: PASSWORD,
      keepSignedIn: false,
      client: CLIENT,
    });
    expect(confirmed.ok).toBe(true);
    return confirmed;
  }

  const registeredEvents = (s: Setup): PendingEvent[] =>
    s.fakes.events.filter((e) => e.type === 'identity.seller-registered.v1');

  describe('SeedRoles', () => {
    it('creates the two system roles once; a second run creates none', async () => {
      const s = setUp();

      // 2 system and 10 default roles (slice 8a-1; the default roles have their own suite).
      await expect(s.seed.execute(system, {})).resolves.toEqual({
        ok: true,
        value: { created: 12, upgraded: 0 },
      });
      await expect(s.seed.execute(system, {})).resolves.toEqual({
        ok: true,
        value: { created: 0, upgraded: 0 },
      });

      expect(
        [...s.fakes.roles.values()]
          .filter((r) => r.kind === 'system')
          .map((r) => [r.marketId, r.scope, r.kind, r.seedCode])
          .sort(),
      ).toEqual([
        [code, 'platform', 'system', 'platform-administrator'],
        [code, 'seller', 'system', 'seller-owner'],
      ]);
      // identity.role.seeded once per created role, as the system; the second run writes none.
      const roleIds = new Map(
        [...s.fakes.roles.values()].filter((r) => r.kind === 'system').map((r) => [r.scope, r.id]),
      );
      expect(
        s.fakes.audits
          .filter((a) => [...roleIds.values()].includes(a.targetId as never))
          .map((a) => [a.action, a.actor, a.marketId, a.targetId, a.after])
          .sort(),
      ).toEqual([
        [
          'identity.role.seeded',
          'system',
          code,
          roleIds.get('platform'),
          { scope: 'platform', kind: 'system', seedVersion: expect.any(Number) as unknown },
        ],
        [
          'identity.role.seeded',
          'system',
          code,
          roleIds.get('seller'),
          { scope: 'seller', kind: 'system', seedVersion: expect.any(Number) as unknown },
        ],
      ]);
    });

    it('refuses any actor but the system', async () => {
      await expect(setUp().seed.execute(anonymous, {})).resolves.toMatchObject({ ok: false });
    });
  });

  describe('RegisterSeller', () => {
    it('answers access.unavailable and writes nothing before the system roles are seeded', async () => {
      const s = setUp();
      const errors = jest.spyOn(Logger.prototype, 'error');

      await expect(
        s.register.execute(anonymous, {
          displayName: NAME,
          email: EMAIL,
          password: PASSWORD,
          origin: ORIGIN,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(s.fakes.accounts.size).toBe(0);
      expect(s.fakes.sellerAccess.size).toBe(0);
      // A distinct reason, so an operator tells a missing seed from an outage (Ali 2a).
      expect(errors).toHaveBeenCalledWith({
        msg: 'identity.register-seller.unavailable',
        reason: 'roles-not-seeded',
        marketId: code,
        correlationId: 'seller-test-0001',
      });
    });

    it('creates the seller, its owner, membership and founding assignment in one serializable unit', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      s.units.length = 0;

      await signUp(s);

      expect(s.units).toContainEqual({ isolation: 'serializable' });
      const owner = account(s);
      expect(owner).toMatchObject({
        marketId: code,
        population: 'seller',
        displayName: NAME,
        status: 'active',
        emailVerifiedAt: null,
      });
      const seller = sellerOf(s);
      expect(seller).toMatchObject({
        marketId: code,
        origin: 'self',
        state: expectedState,
        registeredAt: null,
      });
      expect([...s.fakes.memberships.values()]).toEqual([
        expect.objectContaining({
          accountId: owner.id,
          sellerId: seller.sellerId,
          state: 'active',
        }),
      ]);
      const sellerRole = [...s.fakes.roles.values()].find((r) => r.scope === 'seller')!;
      expect([...s.fakes.assignments.values()]).toEqual([
        expect.objectContaining({
          accountId: owner.id,
          roleId: sellerRole.id,
          assignedByAccountId: null,
        }),
      ]);
      expect(s.fakes.subjectKeys.get(owner.id)).toBe('live');
      expect(s.fakes.subjectKeys.get(seller.sellerId)).toBe('live');
      // The seller is published at the owner's verification, not at sign-up (8.2).
      expect(s.fakes.events.map((e) => e.type)).toEqual(['identity.one-time-link-requested.v1']);
    });

    it('signs up again on an unverified address: one seller, a new link, the same answer', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);

      await signUp(s, ` ${EMAIL.toUpperCase()} `);

      expect(s.fakes.sellerAccess.size).toBe(1);
      expect(s.fakes.memberships.size).toBe(1);
      expect(s.fakes.events.map((e) => e.type)).toEqual([
        'identity.one-time-link-requested.v1',
        'identity.sign-up-repeated.v1',
        'identity.one-time-link-requested.v1',
      ]);
    });

    it('keeps a customer account with the same email separate', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);

      expect([...s.fakes.accounts.values()].map((a) => [a.population, a.email.normalized])).toEqual(
        [['seller', EMAIL.toLowerCase()]],
      );
    });

    it('refuses a blank name and a password equal to the name', async () => {
      const s = setUp();
      await s.seed.execute(system, {});

      await expect(
        s.register.execute(anonymous, {
          displayName: '  ',
          email: EMAIL,
          password: PASSWORD,
          origin: ORIGIN,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      await expect(
        s.register.execute(anonymous, {
          displayName: PASSWORD,
          email: EMAIL,
          password: PASSWORD,
          origin: ORIGIN,
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(s.fakes.accounts.size).toBe(0);
    });
  });

  describe('ConfirmSellerEmail', () => {
    it('mails the link to the seller page, then confirming records seller-registered once', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);
      const token = await mailedToken(s);
      const target = policy.target(market, 'seller', 'verify-email')!;
      expect(s.fakes.mails.at(-1)!.text).toContain(target);

      const result = await s.confirm.execute(anonymous, {
        token,
        password: PASSWORD,
        keepSignedIn: false,
        client: CLIENT,
      });

      expect(result).toEqual({
        ok: true,
        value: {
          code: 'signed-in',
          token: expect.stringMatching(/^ms1_/) as unknown,
          absoluteLifetimeSeconds: sessionLifetime.absoluteLifetimeSeconds,
          persistent: false,
          sellerAccess: expectedState,
        },
      });
      const seller = sellerOf(s);
      expect(seller.registeredAt).toEqual(START);
      expect(registeredEvents(s)).toEqual([
        expect.objectContaining({
          aggregateId: seller.sellerId,
          payload: {
            sellerId: seller.sellerId,
            ownerAccountId: account(s).id,
            origin: 'self',
            accessState: expectedState,
          },
        }),
      ]);
      const [stored] = [...s.fakes.sessions.values()];
      expect(stored!.session).toMatchObject({
        population: 'seller',
        sellerId: seller.sellerId,
        idleTimeoutSeconds: sessionLifetime.idleTimeoutSeconds,
      });
    });

    it('writes the three founding rows as anonymous, naming the seller, the owner and the bound account', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);
      const token = await mailedToken(s);
      s.fakes.audits.length = 0;
      // A wrong password verifies nothing and writes no row.
      const refused = await s.confirm.execute(anonymous, {
        token,
        password: `${PASSWORD}!`,
        keepSignedIn: false,
        client: CLIENT,
      });
      expect(refused.ok).toBe(false);
      expect(s.fakes.audits).toEqual([]);

      await s.confirm.execute(anonymous, {
        token,
        password: PASSWORD,
        keepSignedIn: false,
        client: CLIENT,
      });

      const { sellerId } = sellerOf(s);
      const accountId = account(s).id;
      const [assignment] = [...s.fakes.assignments.values()].filter(
        (a) => a.accountId === accountId,
      );
      const named = { sellerId, accountId, boundSubjectId: accountId };
      expect(s.fakes.audits).toEqual([
        {
          action: 'identity.seller-access.founded',
          targetType: 'identity.seller-access',
          targetId: sellerId,
          before: null,
          after: { ...named, state: expectedState, origin: 'self' },
          actor: 'anonymous',
          marketId: code,
        },
        {
          action: 'identity.seller-member.added',
          targetType: 'identity.seller-access',
          targetId: sellerId,
          before: null,
          after: { ...named, roleId: assignment!.roleId, founding: true },
          actor: 'anonymous',
          marketId: code,
        },
        {
          action: 'identity.account-role.assigned',
          targetType: 'identity.account',
          targetId: accountId,
          before: null,
          after: { ...named, roleId: assignment!.roleId, scope: 'seller', founding: true },
          actor: 'anonymous',
          marketId: code,
        },
      ]);
      // AC 12: ids, codes and flags only.
      const text = JSON.stringify(s.fakes.audits);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(NAME);

      // A later sign-in founds nothing again.
      await s.signIn.execute(anonymous, {
        email: EMAIL,
        password: PASSWORD,
        keepSignedIn: false,
        client: CLIENT,
      });
      expect(s.fakes.audits).toHaveLength(3);
    });

    it('a later sign-in records no second seller-registered', async () => {
      const s = setUp();
      await registered(s);

      await s.signIn.execute(anonymous, {
        email: EMAIL,
        password: PASSWORD,
        keepSignedIn: false,
        client: CLIENT,
      });

      expect(registeredEvents(s)).toHaveLength(1);
    });
  });

  describe('SignInSeller', () => {
    const input = (keepSignedIn: boolean, password = PASSWORD) => ({
      email: EMAIL,
      password,
      keepSignedIn,
      client: CLIENT,
    });

    it.each([false, true])(
      'opens a seller session with the lifetime of "keep me signed in" = %s',
      async (keepSignedIn) => {
        const s = setUp();
        await registered(s);
        const lifetime = keepSignedIn ? keptLifetime : sessionLifetime;

        const result = await s.signIn.execute(anonymous, input(keepSignedIn));

        expect(result).toEqual({
          ok: true,
          value: expect.objectContaining({
            absoluteLifetimeSeconds: lifetime.absoluteLifetimeSeconds,
            persistent: keepSignedIn,
            sellerAccess: expectedState,
          }) as unknown,
        });
        const sessions = [...s.fakes.sessions.values()].map((x) => x.session);
        expect(sessions.at(-1)).toMatchObject({
          idleTimeoutSeconds: lifetime.idleTimeoutSeconds,
          absoluteExpiresAt: START.add({ seconds: lifetime.absoluteLifetimeSeconds }),
        });
      },
    );

    it('answers email-verification-required to an unverified owner', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);

      await expect(s.signIn.execute(anonymous, input(false))).resolves.toEqual({
        ok: false,
        error: { code: 'email-verification-required' },
      });
    });

    it('answers membership.none only after the password, and credentials.invalid before', async () => {
      const s = setUp();
      await registered(s);
      s.fakes.memberships.clear();

      await expect(
        s.signIn.execute(anonymous, input(false, 'wrong password, wrong')),
      ).resolves.toEqual({ ok: false, error: { code: 'credentials.invalid' } });
      await expect(s.signIn.execute(anonymous, input(false))).resolves.toEqual({
        ok: false,
        error: { code: 'membership.none' },
      });
    });

    it('answers seller-access.suspended to a suspended seller', async () => {
      const s = setUp();
      await registered(s);
      const seller = sellerOf(s);
      s.fakes.seedSellerAccess({ ...seller, state: 'suspended' });

      await expect(s.signIn.execute(anonymous, input(false))).resolves.toEqual({
        ok: false,
        error: { code: 'seller-access.suspended' },
      });
    });

    it('answers credentials.invalid for a customer account with that email', async () => {
      const s = setUp();
      await registered(s);
      const owner = account(s);
      s.fakes.accounts.delete(owner.id);
      s.fakes.seedAccount({ ...owner, population: 'customer', displayName: null });

      await expect(s.signIn.execute(anonymous, input(false))).resolves.toEqual({
        ok: false,
        error: { code: 'credentials.invalid' },
      });
    });
  });

  describe('the status page and membershipOf', () => {
    it("describes the owner's seller, also while it waits for approval", async () => {
      const s = setUp();
      await registered(s);

      await expect(s.status.execute(actorOf(s), {})).resolves.toEqual({
        ok: true,
        value: {
          sellerId: sellerOf(s).sellerId,
          state: expectedState,
          stateChangedAt: START.toString(),
          accountCreatedAt: START.toString(),
          emailConfirmedAt: START.toString(),
          reason: null,
        },
      });
    });

    it('answers the own membership with its role, and access.denied for another account', async () => {
      const s = setUp();
      await registered(s);
      const sellerRole = [...s.fakes.roles.values()].find((r) => r.scope === 'seller')!;

      await expect(
        s.membershipOf.execute(actorOf(s), { accountId: account(s).id }),
      ).resolves.toEqual({
        ok: true,
        value: { sellerId: sellerOf(s).sellerId, roleId: sellerRole.id },
      });
      await expect(
        s.membershipOf.execute(actorOf(s), {
          accountId: '01990000-0000-7000-8000-0000000000ff' as Id<'Account'>,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('denies a session actor claiming another seller', async () => {
      const s = setUp();
      await registered(s);

      await expect(
        s.status.execute(actorOf(s, '01990000-0000-7000-8000-0000000000fe' as Id<'Seller'>), {}),
      ).resolves.toMatchObject({ ok: false });
    });
  });

  describe('sellerAccessOf and the registered seller paging (8.1; ADR-0022; R-6)', () => {
    it('answers registered sellers only, once each, for request and system actors', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);
      const sellerId = sellerOf(s).sellerId;

      // Not registered until the owner confirms: absent, read as "may not sell".
      await expect(s.accessOf.execute(anonymous, { sellerIds: [sellerId] })).resolves.toEqual({
        ok: true,
        value: [],
      });

      const token = await mailedToken(s);
      await s.confirm.execute(anonymous, {
        token,
        password: PASSWORD,
        keepSignedIn: false,
        client: CLIENT,
      });

      const expected = {
        ok: true,
        value: [expect.objectContaining({ sellerId, state: expectedState })],
      };
      await expect(
        s.accessOf.execute(anonymous, { sellerIds: [sellerId, sellerId] }),
      ).resolves.toEqual(expected);
      await expect(s.accessOfSystem.execute(system, { sellerIds: [sellerId] })).resolves.toEqual(
        expected,
      );
      await expect(
        s.accessOfSystem.execute(anonymous, { sellerIds: [sellerId] }),
      ).resolves.toMatchObject({ ok: false });
    });

    it('refuses more than 100 ids and a malformed id', async () => {
      const s = setUp();
      const many = Array.from(
        { length: 101 },
        (_, i) => `01990000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      );

      await expect(s.accessOf.execute(anonymous, { sellerIds: many })).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      await expect(
        s.accessOf.execute(anonymous, { sellerIds: ['not-an-id'] }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('pages registered sellers by id for the system actor only', async () => {
      const s = setUp();
      const ids = ['b', 'a', 'c'].map(
        (x) => `01990000-0000-7000-8000-00000000000${x}` as Id<'Seller'>,
      );
      for (const sellerId of ids) {
        s.fakes.seedSellerAccess({
          sellerId,
          marketId: code as AccountState['marketId'],
          origin: 'self',
          state: 'approved',
          stateChangedAt: START,
          reapplyCount: 0,
          registeredAt: sellerId.endsWith('c') ? null : START,
          version: 1,
          createdAt: START,
        });
      }

      const first = await s.list.execute(system, { limit: 1 });
      expect(first).toEqual({
        ok: true,
        value: { items: [{ sellerId: ids[1], origin: 'self' }], next: ids[1] },
      });
      const second = await s.list.execute(system, { after: ids[1], limit: 500 });
      expect(second).toEqual({
        ok: true,
        value: { items: [{ sellerId: ids[0], origin: 'self' }], next: null },
      });
      await expect(s.list.execute(system, { limit: 0 })).resolves.toMatchObject({
        error: { code: 'validation.failed' },
      });
      await expect(s.list.execute(system, { limit: 501 })).resolves.toMatchObject({
        error: { code: 'validation.failed' },
      });
      await expect(s.list.execute(anonymous, { limit: 1 })).resolves.toMatchObject({ ok: false });

      // A last page exactly `limit` long says so: no empty extra page (Sajad gap 3).
      await expect(s.list.execute(system, { limit: 2 })).resolves.toEqual({
        ok: true,
        value: {
          items: [
            { sellerId: ids[1], origin: 'self' },
            { sellerId: ids[0], origin: 'self' },
          ],
          next: null,
        },
      });
    });

    it('a failed read fails closed and logs a warning, for both reads', async () => {
      const s = setUp();
      const failing: UnitOfWork = {
        run: () => Promise.resolve({ ok: false, error: 'read failed' }) as never,
        runOnce: () => Promise.reject(new Error('not used')),
      };
      const gate = createUseCaseGate(markets, null);
      const deps = { unitOfWork: failing, sellerAccess: s.fakes.sellerAccessRepository };
      const warnings = jest.spyOn(Logger.prototype, 'warn');

      await expect(
        new ListRegisteredSellers(gate, deps).execute(system, { limit: 5 }),
      ).resolves.toEqual({ ok: true, value: { items: [], next: null } });
      await expect(
        new SellerAccessOfSystem(gate, deps).execute(system, {
          sellerIds: ['01990000-0000-7000-8000-00000000000a'],
        }),
      ).resolves.toEqual({ ok: true, value: [] });

      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'identity.list-registered-sellers.read-failed',
          marketId: code,
        }),
      );
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'identity.seller-access-of.read-failed', marketId: code }),
      );
    });
  });

  describe('SendWelcomeMail', () => {
    it("sends the Market's welcome once per delivery, saying whether approval is pending", async () => {
      const s = setUp();
      await registered(s);
      const [event] = registeredEvents(s);
      const payload = event!.payload as {
        sellerId: Id;
        ownerAccountId: Id;
        origin: 'self';
        accessState: 'pending' | 'approved';
      };
      const delivery = deliveryOf('identity.welcome-mail');
      const mailsBefore = s.fakes.mails.length;

      await expect(s.welcome.execute(system, { delivery, ...payload })).resolves.toEqual({
        ok: true,
        value: { code: 'welcome-mail.sent' },
      });
      const expected = composer.compose(market, {
        template: 'welcome',
        population: 'seller',
        url: policy.target(market, 'seller', 'sign-in')!,
        approvalRequired,
      });
      expect(s.fakes.mails.slice(mailsBefore)).toEqual([
        expect.objectContaining({
          to: EMAIL,
          from: policy.mailSender(market),
          subject: expected.subject,
          text: expected.text,
        }),
      ]);
      await expect(s.welcome.execute(system, { delivery, ...payload })).resolves.toMatchObject({
        value: { code: 'welcome-mail.already-handled' },
      });
    });

    it('skips an invited seller, a missing owner and an unverified owner', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);
      const base = {
        sellerId: sellerOf(s).sellerId,
        ownerAccountId: account(s).id,
        origin: 'self' as const,
        accessState: expectedState,
      };
      const mailsBefore = s.fakes.mails.length;

      for (const [input, reason] of [
        [{ ...base, origin: 'invitation' as const }, 'origin.not-self'],
        [{ ...base, ownerAccountId: null }, 'owner.none'],
        [base, 'account.unverified'],
      ] as const) {
        await expect(
          s.welcome.execute(system, { delivery: deliveryOf('identity.welcome-mail'), ...input }),
        ).resolves.toEqual({ ok: true, value: { code: 'welcome-mail.skipped', reason } });
      }
      expect(s.fakes.mails.length).toBe(mailsBefore);
    });
  });

  describe('no reviewer notice at email verification (identity design 8.7; R-3 switch-off)', () => {
    const reviewerNotice = () =>
      composer.compose(market, {
        template: 'reviewer-notice',
        population: 'admin',
        url: policy.target(market, 'admin', 'seller-review-queue')!,
      });

    it("confirming a seller's email sends only the welcome mail, through every identity subscription", async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);
      const token = await mailedToken(s);
      const eventsBefore = s.fakes.events.length;
      const mailsBefore = s.fakes.mails.length;

      const confirmed = await s.confirm.execute(anonymous, {
        token,
        password: PASSWORD,
        keepSignedIn: false,
        client: CLIENT,
      });
      expect(confirmed.ok).toBe(true);
      // Deliver every event the confirmation recorded to every identity subscription of its type.
      const recorded = s.fakes.events.slice(eventsBefore);
      expect(recorded.map((e) => e.type)).toContain('identity.seller-registered.v1');
      for (const event of recorded) {
        for (const subscription of s.subscriptions.filter((x) => x.event.type === event.type)) {
          await subscription.handle(
            event as unknown as ConsumedEnvelope,
            deliveryOf(subscription.name),
            system as SubscriberContext,
          );
        }
      }

      const mails = s.fakes.mails.slice(mailsBefore);
      const welcome = composer.compose(market, {
        template: 'welcome',
        population: 'seller',
        url: policy.target(market, 'seller', 'sign-in')!,
        approvalRequired,
      });
      expect(mails.map((m) => [m.to, m.subject])).toEqual([[EMAIL, welcome.subject]]);
      expect(mails.map((m) => m.subject)).not.toContain(reviewerNotice().subject);
    });

    it('no identity subscription sends the reviewer notice (snapshot of the subscription names)', () => {
      const s = setUp();

      expect(s.subscriptions.map((x) => [x.name, x.event.type])).toEqual([
        ['identity.link-mail', 'identity.one-time-link-requested.v1'],
        ['identity.existing-account-mail', 'identity.sign-up-repeated.v1'],
        ['identity.welcome-mail', 'identity.seller-registered.v1'],
        ['identity.password-changed-mail', 'identity.account-password-changed.v1'],
      ]);
      expect(s.subscriptions.map((x) => x.event.type)).not.toContain(
        'identity.account-email-verified.v1',
      );
    });
  });

  describe('PurgeUnverifiedAccounts for a seller owner (3.1; M5)', () => {
    it('removes the assignment, the membership, the account and the unregistered seller with its key', async () => {
      const s = setUp();
      await s.seed.execute(system, {});
      await signUp(s);
      const owner = account(s).id;
      const sellerId = sellerOf(s).sellerId;
      const days = policy.unverifiedAccountRetentionDays(market);

      s.clock.advance(Temporal.Duration.from({ hours: days * 24 + 1 }));
      await expect(s.purge.execute(system, {})).resolves.toEqual({
        ok: true,
        value: { deleted: 1, skipped: 0 },
      });

      expect(s.fakes.accounts.size).toBe(0);
      expect(s.fakes.memberships.size).toBe(0);
      expect(s.fakes.assignments.size).toBe(0);
      expect(s.fakes.sellerAccess.size).toBe(0);
      expect(s.fakes.subjectKeys.get(owner)).toBe('destroyed');
      expect(s.fakes.subjectKeys.get(sellerId)).toBe('destroyed');
      // The roles stay: they belong to the Market.
      expect(s.fakes.roles.size).toBe(new CheckedInRoleSeed().roles().length);
    });

    it('never touches a registered seller', async () => {
      const s = setUp();
      await registered(s);
      const days = policy.unverifiedAccountRetentionDays(market);

      s.clock.advance(Temporal.Duration.from({ hours: days * 24 + 1 }));
      await expect(s.purge.execute(system, {})).resolves.toEqual({
        ok: true,
        value: { deleted: 0, skipped: 0 },
      });
      expect(s.fakes.sellerAccess.size).toBe(1);
    });
  });
});
