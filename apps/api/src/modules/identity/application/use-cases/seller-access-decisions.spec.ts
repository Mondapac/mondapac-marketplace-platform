import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
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
import { loadLocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import { MAX_ACCESS_REASON_LENGTH } from '../../domain/access-decision';
import { openSession } from '../../domain/session';
import { issueChallenge } from '../../domain/sign-in-challenge';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import { CatalogueMailComposer } from '../../infrastructure/mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { SellerAccessContractImplementation } from '../../presentation/seller-access.contract';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import { ApproveSellerAccess } from './approve-seller-access.use-case';
import { DescribeSellerStatus } from './describe-seller-status.use-case';
import { ReapplySellerAccess } from './reapply-seller-access.use-case';
import { ReinstateSellerAccess } from './reinstate-seller-access.use-case';
import { RejectSellerAccess } from './reject-seller-access.use-case';
import { SeedRoles } from './seed-roles.use-case';
import { SendSellerAccessMail } from './send-seller-access-mail.use-case';
import { SuspendSellerAccess } from './suspend-seller-access.use-case';

// Identity slice 9 in memory (identity design 3.3, 8.1, 8.4, 9; data design 3.11; ADR-0022
// decision 4; `ux.md` E4 to E7): the four access decisions with their stored, encrypted reasons,
// the sessions they end, their events and audit rows; the result mails; re-apply; the status
// page's reason; the decisions through the seller-access contract. Both Market fixtures. The
// PostgreSQL side (encryption at rest, CHECKs, privileges) is test/db/access-decisions.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const REASON = 'Canary reason: the food-safety licence number does not match | twice';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const basePolicy = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const n12 = (n: number) => String(n).padStart(12, '0');
const uuid = <T extends string>(n: number) => `01990000-0000-7000-8000-${n12(n)}` as Id<T>;
const SELLER = uuid<'Seller'>(0xb001);
const OTHER_SELLER = uuid<'Seller'>(0xb002);
const OWNER = uuid<'Account'>(0xa001);
const STAFF = uuid<'Account'>(0xa002);
const ADMIN = uuid<'Account'>(0xa003);
const VIEWER = uuid<'Account'>(0xa004);
const OWNER_EMAIL = 'owner@seller.example';
const STAFF_EMAIL = 'staff@seller.example';

/**
 * The real policy (both Market files configure a re-apply limit of 3), or, with `null`, the
 * policy of a Market that configures none.
 */
function policyWith(limit: undefined | null): MarketConfigIdentityPolicy {
  if (limit === undefined) return basePolicy;
  return Object.assign(Object.create(basePolicy) as MarketConfigIdentityPolicy, {
    sellerReapplyLimit: () => limit,
  });
}

const notUsed = <T>(): T =>
  ({
    execute: () => Promise.reject(new Error('not used in this spec')),
  }) as unknown as T;

function setUp(options: { readonly reapplyLimit?: null } = {}) {
  const fakes = new IdentityFakes();
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const policy = policyWith(options.reapplyLimit);
  const units: (UnitOfWorkOptions | undefined)[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, opts?: UnitOfWorkOptions) => {
      units.push(opts);
      return fakes.unitOfWork.run(m, work);
    },
    runOnce: (m, delivery, work, opts) => fakes.unitOfWork.runOnce(m, delivery, work, opts),
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
  const decisionDeps = {
    unitOfWork,
    sellerAccess: fakes.sellerAccessRepository,
    decisions: fakes.decisionRepository,
    accounts: fakes.accountRepository,
    memberships: fakes.membershipRepository,
    grants: fakes.grantReader,
    effectiveKeys: realEffectiveKeys(),
    sessions: fakes.sessionRepository,
    challenges: fakes.challengeRepository,
    outbox: fakes.outbox,
    audit: fakes.audit,
    clock,
    ids,
  };
  const approve = new ApproveSellerAccess(gate, decisionDeps);
  const reject = new RejectSellerAccess(gate, decisionDeps);
  const reapply = new ReapplySellerAccess(gate, {
    unitOfWork,
    sellerAccess: fakes.sellerAccessRepository,
    accounts: fakes.accountRepository,
    memberships: fakes.membershipRepository,
    grants: fakes.grantReader,
    effectiveKeys: realEffectiveKeys(),
    policy,
    outbox: fakes.outbox,
    audit: fakes.audit,
    clock,
  });
  return {
    fakes,
    clock,
    units,
    approve,
    reject,
    suspend: new SuspendSellerAccess(gate, decisionDeps),
    reinstate: new ReinstateSellerAccess(gate, decisionDeps),
    reapply,
    mail: new SendSellerAccessMail(gate, {
      unitOfWork,
      decisions: fakes.decisionRepository,
      memberships: fakes.membershipRepository,
      grants: fakes.grantReader,
      accounts: fakes.accountRepository,
      targets: policy,
      composer,
      transport: fakes.mailTransport,
      policy,
    }),
    status: new DescribeSellerStatus(gate, {
      unitOfWork,
      accounts: fakes.accountRepository,
      sellerAccess: fakes.sellerAccessRepository,
      decisions: fakes.decisionRepository,
      grants: fakes.grantReader,
      policy,
    }),
    contract: new SellerAccessContractImplementation({
      sellerAccessOf: notUsed(),
      sellerAccessOfSystem: notUsed(),
      listRegisteredSellers: notUsed(),
      notifyAccessReviewers: notUsed(),
      approveSellerAccess: approve,
      rejectSellerAccess: reject,
      reapplySellerAccess: reapply,
      listSellerAccessDecisions: notUsed(),
      findAccessDecisionsByBasis: notUsed(),
    }),
    seed: new SeedRoles(gate, {
      unitOfWork,
      roles: fakes.roleRepository,
      seed: new CheckedInRoleSeed(),
      permissions: realPermissionRegistry(),
      clock,
      ids,
      audit: fakes.audit,
    }),
  };
}

type Setup = ReturnType<typeof setUp>;

let deliveries = 0;
const deliveryOf = (subscriber: string): EventDelivery => ({
  eventId: `0199eeee-0000-7000-8000-${n12(++deliveries)}` as Id<'event'>,
  subscriber,
  attempt: 1,
});

describe.each(TEST_MARKETS)('seller access decisions in market %s (slice 9)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const otherCode = TEST_MARKETS.find((c) => c !== code)!;
  const marketId = code as AccountState['marketId'];
  const system = testCallContext(market, 'system');
  const adminOf = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: uuid<'Session'>(0xc000 + Number.parseInt(accountId.slice(-4), 16)),
        sellerId: null,
      }),
    );
  const sellerActorOf = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: uuid<'Session'>(0xd000 + Number.parseInt(accountId.slice(-4), 16)),
        sellerId: SELLER,
      }),
    );
  const admin = adminOf(ADMIN);

  /** Roles, the seller with its owner and one staff member, two admins, one session each. */
  async function seeded(
    s: Setup,
    state: SellerAccessStateCode,
    options: { readonly ownerVerified?: boolean } = {},
  ) {
    await s.seed.execute(system, {});
    const roleOf = (scope: string, seedCode: string) =>
      [...s.fakes.roles.values()].find((r) => r.scope === scope && r.seedCode === seedCode)!.id;
    const account = (
      id: Id<'Account'>,
      population: AccountState['population'],
      email: string,
      verified = true,
    ) =>
      s.fakes.seedAccount({
        id,
        marketId,
        population,
        email: { typed: email, normalized: email },
        displayName: `Name of ${email}`,
        status: 'active',
        emailVerifiedAt: verified ? START : null,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
      });
    const assign = (n: number, accountId: Id<'Account'>, roleId: Id<'Role'>) =>
      s.fakes.seedAssignment({
        id: uuid<'RoleAssignment'>(0xe000 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    const member = (n: number, accountId: Id<'Account'>) =>
      s.fakes.seedMembership({
        id: uuid<'SellerMembership'>(0xf000 + n),
        marketId,
        accountId,
        sellerId: SELLER,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
    account(OWNER, 'seller', OWNER_EMAIL, options.ownerVerified ?? true);
    account(STAFF, 'seller', STAFF_EMAIL);
    account(ADMIN, 'admin', 'admin@example.com');
    account(VIEWER, 'admin', 'viewer@example.com');
    assign(1, OWNER, roleOf('seller', 'seller-owner'));
    assign(2, STAFF, roleOf('seller', 'store-manager'));
    assign(3, ADMIN, roleOf('platform', 'onboarding-compliance'));
    assign(4, VIEWER, roleOf('platform', 'viewer'));
    member(1, OWNER);
    member(2, STAFF);
    for (const [sellerId, m] of [
      [SELLER, marketId],
      [OTHER_SELLER, otherCode as AccountState['marketId']],
    ] as const) {
      s.fakes.seedSellerAccess({
        sellerId,
        marketId: m,
        origin: 'self',
        state,
        stateChangedAt: START,
        reapplyCount: 0,
        registeredAt: START,
        version: 3,
        createdAt: START,
      });
      s.fakes.subjectKeys.set(sellerId, 'live');
    }
    for (const [n, accountId] of [
      [1, OWNER],
      [2, STAFF],
    ] as const) {
      await s.fakes.sessionRepository.add(
        market,
        openSession({
          id: uuid<'Session'>(0xd100 + n),
          marketId,
          accountId,
          population: 'seller',
          sellerId: SELLER,
          transport: 'cookie',
          lifetime: LIFETIME,
          now: START,
        }),
        Buffer.from(`token-${n}`),
      );
    }
    s.fakes.events.length = 0;
    s.fakes.audits.length = 0;
  }

  const liveSessions = (s: Setup) =>
    [...s.fakes.sessions.values()].filter((x) => x.session.revokedAt === null).length;
  const stateOf = (s: Setup) => s.fakes.sellerAccess.get(SELLER)!.state;
  const mailFor = (
    s: Setup,
    decision: 'approved' | 'rejected' | 'suspended' | 'reinstated',
    decisionId: Id,
  ) =>
    s.mail.execute(system, {
      delivery: deliveryOf(`identity.seller-${decision}-mail`),
      sellerId: SELLER,
      decisionId,
      decision,
    });

  it('approves a pending seller: the decision, its event and audit row, no session ends, the owner is mailed', async () => {
    const s = setUp();
    await seeded(s, 'pending');

    const result = await s.approve.execute(admin, { sellerId: SELLER, basisId: null });

    expect(result).toEqual({
      ok: true,
      value: {
        code: 'seller-access.approved',
        sellerId: SELLER,
        state: 'approved',
        decisionId: expect.any(String) as string,
        revokedSessions: 0,
      },
    });
    const decisionId = (result.ok && result.value.decisionId) as Id;
    expect(stateOf(s)).toBe('approved');
    expect(s.fakes.decisions.get(decisionId)).toEqual({
      state: expect.objectContaining({
        sellerId: SELLER,
        decision: 'approved',
        basisId: null,
        decidedByAccountId: ADMIN,
        decidedAt: START,
      }) as object,
      cipher: null,
    });
    expect(s.fakes.events.map((e) => [e.type, e.payload])).toEqual([
      ['identity.seller-access-approved.v1', { sellerId: SELLER, decisionId, basisId: null }],
    ]);
    expect(s.fakes.audits).toEqual([
      expect.objectContaining({
        action: 'identity.seller-access.approved',
        actor: 'authenticated',
        marketId: code,
      }),
    ]);
    // C11: a decision writes no role, membership or account status: READ COMMITTED, after the
    // seller row's lock (item H).
    expect(s.units.at(-1)?.isolation).not.toBe('serializable');
    expect(s.fakes.sellerLocks).toContain(SELLER);
    expect(liveSessions(s)).toBe(2);

    await expect(mailFor(s, 'approved', decisionId)).resolves.toEqual({
      ok: true,
      value: { code: 'seller-access-mail.sent' },
    });
    expect(s.fakes.mails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect(s.fakes.mails[0]!.text).toContain('https://');
  });

  it('rejects with a reason: stored only encrypted, sessions end, only the owner reads it', async () => {
    const s = setUp();
    await seeded(s, 'pending');

    const result = await s.reject.execute(admin, {
      sellerId: SELLER,
      reason: `  ${REASON}  `,
      basisId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { code: 'seller-access.rejected', state: 'rejected', revokedSessions: 2 },
    });
    const decisionId = (result.ok && result.value.decisionId) as Id;
    expect(liveSessions(s)).toBe(0);
    const stored = s.fakes.decisions.get(decisionId)!;
    // Sealed through the subject-key service under the seller's key and the field's label (the
    // fake's ciphertext is readable; test/db checks the real one is not).
    expect(stored.cipher).toBe(`fake1|${code}|${SELLER}|identity.access-decision.reason|${REASON}`);
    // HF13: never in an event, an audit row or the answer.
    expect(JSON.stringify([s.fakes.events, s.fakes.audits, result])).not.toContain('food-safety');

    await expect(mailFor(s, 'rejected', decisionId)).resolves.toMatchObject({ ok: true });
    expect(s.fakes.mails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect(s.fakes.mails[0]!.text).toContain(REASON);
    expect(s.fakes.mails[0]!.subject).not.toContain('food-safety');

    const owner = await s.status.execute(sellerActorOf(OWNER), {});
    const staff = await s.status.execute(sellerActorOf(STAFF), {});
    expect(owner).toMatchObject({
      ok: true,
      value: { state: 'rejected', reason: REASON, decidedAt: START.toString() },
    });
    expect(staff).toMatchObject({ ok: true, value: { state: 'rejected', reason: null } });
  });

  it('suspends with a reason, then reinstates; the stale suspension mail is skipped', async () => {
    const s = setUp();
    await seeded(s, 'approved');

    const suspended = await s.suspend.execute(admin, { sellerId: SELLER, reason: REASON });
    expect(suspended).toMatchObject({
      ok: true,
      value: { code: 'seller-access.suspended', state: 'suspended', revokedSessions: 2 },
    });
    const suspensionId = (suspended.ok && suspended.value.decisionId) as Id;
    s.clock.advance(Temporal.Duration.from({ minutes: 5 }));
    const reinstated = await s.reinstate.execute(admin, { sellerId: SELLER });
    expect(reinstated).toMatchObject({
      ok: true,
      value: { code: 'seller-access.reinstated', state: 'approved', revokedSessions: 0 },
    });
    const reinstatementId = (reinstated.ok && reinstated.value.decisionId) as Id;

    await expect(mailFor(s, 'suspended', suspensionId)).resolves.toEqual({
      ok: true,
      value: { code: 'seller-access-mail.skipped', reason: 'decision.superseded' },
    });
    await expect(mailFor(s, 'reinstated', reinstatementId)).resolves.toEqual({
      ok: true,
      value: { code: 'seller-access-mail.sent' },
    });
    expect(s.fakes.audits.map((a) => a.action)).toEqual([
      'identity.seller-access.suspended',
      'identity.seller-access.reinstated',
    ]);
    expect(s.fakes.events.map((e) => e.type)).toEqual([
      'identity.seller-access-suspended.v1',
      'identity.seller-access-reinstated.v1',
    ]);
  });

  it('skips the mail when the reason was erased with the seller key', async () => {
    const s = setUp();
    await seeded(s, 'pending');
    const result = await s.reject.execute(admin, {
      sellerId: SELLER,
      reason: REASON,
      basisId: null,
    });
    s.fakes.subjectKeys.set(SELLER, 'destroyed');

    await expect(
      mailFor(s, 'rejected', (result.ok && result.value.decisionId) as Id),
    ).resolves.toEqual({
      ok: true,
      value: { code: 'seller-access-mail.skipped', reason: 'reason.erased' },
    });
    expect(s.fakes.mails).toEqual([]);
  });

  describe('refusals record nothing', () => {
    const cases: [string, SellerAccessStateCode, (s: Setup) => Promise<unknown>, unknown][] = [
      [
        'an admin without the permission',
        'pending',
        (s) => s.approve.execute(adminOf(VIEWER), { sellerId: SELLER, basisId: null }),
        { code: 'access.denied' },
      ],
      [
        'a seller of another Market',
        'pending',
        (s) => s.approve.execute(admin, { sellerId: OTHER_SELLER, basisId: null }),
        { code: 'seller.unknown' },
      ],
      [
        'a seller that does not exist',
        'pending',
        (s) => s.approve.execute(admin, { sellerId: uuid<'Seller'>(0xbfff), basisId: null }),
        { code: 'seller.unknown' },
      ],
      [
        'approving an approved seller',
        'approved',
        (s) => s.approve.execute(admin, { sellerId: SELLER, basisId: null }),
        { code: 'seller-access.wrong-state' },
      ],
      [
        'reinstating a seller that is not suspended',
        'rejected',
        (s) => s.reinstate.execute(admin, { sellerId: SELLER }),
        { code: 'seller-access.wrong-state' },
      ],
      [
        'a rejection without a reason',
        'pending',
        (s) => s.reject.execute(admin, { sellerId: SELLER, reason: '   ', basisId: null }),
        { code: 'seller-access.reason-required' },
      ],
      [
        'a reason with a bidi control (HF13)',
        'approved',
        (s) => s.suspend.execute(admin, { sellerId: SELLER, reason: 'ok ‮ evil' }),
        { code: 'validation.failed', rule: 'characters' },
      ],
      [
        'a reason over the length limit',
        'approved',
        (s) =>
          s.suspend.execute(admin, {
            sellerId: SELLER,
            reason: 'x'.repeat(MAX_ACCESS_REASON_LENGTH + 1),
          }),
        { code: 'validation.failed', rule: 'length' },
      ],
    ];

    it.each(cases)('refuses %s', async (_name, state, run, error) => {
      const s = setUp();
      await seeded(s, state);

      await expect(run(s)).resolves.toEqual({ ok: false, error });
      expect([s.fakes.decisions.size, s.fakes.events.length, s.fakes.audits.length]).toEqual([
        0, 0, 0,
      ]);
      expect(stateOf(s)).toBe(state);
      expect(liveSessions(s)).toBe(2);
    });

    it('refuses to approve while the owner has not confirmed the email', async () => {
      const s = setUp();
      await seeded(s, 'pending', { ownerVerified: false });

      await expect(s.approve.execute(admin, { sellerId: SELLER, basisId: null })).resolves.toEqual({
        ok: false,
        error: { code: 'seller-access.owner-unverified' },
      });
      expect(stateOf(s)).toBe('pending');
    });
  });

  describe('re-apply (3.3)', () => {
    it('answers access.unavailable when the Market configures no limit', async () => {
      const s = setUp({ reapplyLimit: null });
      await seeded(s, 'rejected');

      await expect(s.reapply.execute(sellerActorOf(OWNER), { sellerId: SELLER })).resolves.toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(stateOf(s)).toBe('rejected');
      // Unknown, never true (Mohammad ask 3 on PR #204): no seller is shown "Not approved".
      await expect(s.status.execute(sellerActorOf(OWNER), {})).resolves.toMatchObject({
        ok: true,
        value: { state: 'rejected', reapplyLimitReached: null },
      });
    });

    it("lets the owner apply again up to the Market's limit of 3; staff cannot", async () => {
      const s = setUp();
      await seeded(s, 'rejected');
      expect(basePolicy.sellerReapplyLimit(market)).toBe(3);

      await expect(s.reapply.execute(sellerActorOf(STAFF), { sellerId: SELLER })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      await expect(s.reapply.execute(sellerActorOf(OWNER), { sellerId: SELLER })).resolves.toEqual({
        ok: true,
        value: {
          code: 'seller-access.reapplied',
          sellerId: SELLER,
          state: 'pending',
          reapplyCount: 1,
        },
      });
      expect(s.fakes.events.map((e) => [e.type, e.payload])).toEqual([
        ['identity.seller-access-reapplied.v1', { sellerId: SELLER }],
      ]);
      expect(s.fakes.audits.map((a) => a.action)).toEqual(['identity.seller-access.reapplied']);
      await expect(s.status.execute(sellerActorOf(OWNER), {})).resolves.toMatchObject({
        ok: true,
        value: { state: 'pending', reapplyLimitReached: false },
      });

      for (const reapplyCount of [2, 3]) {
        await s.reject.execute(admin, { sellerId: SELLER, reason: REASON, basisId: null });
        await expect(
          s.reapply.execute(sellerActorOf(OWNER), { sellerId: SELLER }),
        ).resolves.toMatchObject({ ok: true, value: { state: 'pending', reapplyCount } });
      }
      await s.reject.execute(admin, { sellerId: SELLER, reason: REASON, basisId: null });
      await expect(s.reapply.execute(sellerActorOf(OWNER), { sellerId: SELLER })).resolves.toEqual({
        ok: false,
        error: { code: 'seller-access.reapply-limit' },
      });
      await expect(s.status.execute(sellerActorOf(OWNER), {})).resolves.toMatchObject({
        ok: true,
        value: { state: 'rejected', reapplyLimitReached: true },
      });
    });
  });

  describe('through the seller-access contract (ADR-0022 decision 4)', () => {
    it('stores and publishes the basis id, and answers codes and ids, never the reason', async () => {
      const s = setUp();
      await seeded(s, 'pending');
      const basisId = uuid(0x5001);

      const rejected = await s.contract.rejectSellerAccess(admin, SELLER, REASON, basisId);

      expect(rejected).toEqual({
        ok: true,
        value: {
          code: 'seller-access.rejected',
          sellerId: SELLER,
          state: 'rejected',
          decisionId: expect.any(String) as string,
        },
      });
      const decisionId = (rejected.ok && rejected.value.decisionId) as Id;
      expect(s.fakes.decisions.get(decisionId)!.state.basisId).toBe(basisId);
      expect(s.fakes.events.map((e) => e.payload)).toEqual([
        { sellerId: SELLER, decisionId, basisId },
      ]);
      await expect(
        s.contract.approveSellerAccess(adminOf(VIEWER), SELLER, basisId),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('round 1 of PR #204 (Sajad 1, 2, 4)', () => {
    /** An open sign-in challenge for each of the owner and the staff member. */
    async function challenged(s: Setup) {
      for (const [n, accountId] of [
        [1, OWNER],
        [2, STAFF],
      ] as const) {
        await s.fakes.challengeRepository.add(
          market,
          issueChallenge({
            id: uuid<'SignInChallenge'>(0x7000 + n),
            marketId,
            accountId,
            purpose: 'second-factor',
            credentialChangedAt: START,
            policy: { maxAttempts: 5, lifetimeSeconds: 300 },
            now: START,
          }),
          Buffer.from(`challenge-${n}`),
        );
      }
    }
    const openChallengesOf = (s: Setup) =>
      [...s.fakes.challenges.values()].map((c) => c.challenge.accountId).sort();
    const revokedOf = (s: Setup) =>
      Object.fromEntries(
        [...s.fakes.sessions.values()].map((x) => [x.session.accountId, x.session.revokedReason]),
      );

    it('approve voids no challenge and ends no session', async () => {
      const s = setUp();
      await seeded(s, 'pending');
      await challenged(s);

      await s.approve.execute(admin, { sellerId: SELLER, basisId: null });

      expect(openChallengesOf(s)).toEqual([OWNER, STAFF].sort());
      expect(revokedOf(s)).toEqual({ [OWNER]: null, [STAFF]: null });
    });

    it.each([
      ['reject', 'pending' as const, 'seller-rejected'],
      ['suspend', 'approved' as const, 'seller-suspended'],
    ])(
      '%s voids the open challenges and ends the sessions of the owner and the staff',
      async (verb, state, reason) => {
        const s = setUp();
        await seeded(s, state);
        await challenged(s);

        const result =
          verb === 'reject'
            ? await s.reject.execute(admin, { sellerId: SELLER, reason: REASON, basisId: null })
            : await s.suspend.execute(admin, { sellerId: SELLER, reason: REASON });

        expect(result).toMatchObject({ ok: true, value: { revokedSessions: 2 } });
        expect(openChallengesOf(s)).toEqual([]);
        expect(revokedOf(s)).toEqual({ [OWNER]: reason, [STAFF]: reason });
      },
    );

    it('E4, E6, E7: the reason is in the suspension body only, never in a subject', async () => {
      const s = setUp();
      await seeded(s, 'pending');
      const ids: Id[] = [];
      const decided = async (run: () => Promise<Result<{ decisionId: Id }, unknown>>) => {
        const result = await run();
        if (!result.ok) throw new Error('refused');
        ids.push(result.value.decisionId);
        s.clock.advance(Temporal.Duration.from({ minutes: 1 }));
        return result.value.decisionId;
      };
      const approved = await decided(() =>
        s.approve.execute(admin, { sellerId: SELLER, basisId: null }),
      );
      await expect(mailFor(s, 'approved', approved)).resolves.toMatchObject({ ok: true });
      const suspended = await decided(() =>
        s.suspend.execute(admin, { sellerId: SELLER, reason: REASON }),
      );
      await expect(mailFor(s, 'suspended', suspended)).resolves.toMatchObject({ ok: true });
      const reinstated = await decided(() => s.reinstate.execute(admin, { sellerId: SELLER }));
      await expect(mailFor(s, 'reinstated', reinstated)).resolves.toMatchObject({ ok: true });

      const [e4, e6, e7] = s.fakes.mails;
      expect([e4, e6, e7].map((m) => m!.to)).toEqual([OWNER_EMAIL, OWNER_EMAIL, OWNER_EMAIL]);
      expect(e6!.text).toContain(REASON);
      for (const mail of [e4!, e7!]) expect(mail.text).not.toContain('food-safety');
      for (const mail of [e4!, e6!, e7!]) expect(mail.subject).not.toContain('food-safety');
      // E4 and E7 carry the sign-in button; E6 none (the seller cannot sign in).
      expect(e4!.text).toContain('https://');
      expect(e7!.text).toContain('https://');
      expect(e6!.text).not.toContain('https://');
    });

    it('skips an approval mail once a suspension followed it', async () => {
      const s = setUp();
      await seeded(s, 'pending');
      const approved = await s.approve.execute(admin, { sellerId: SELLER, basisId: null });
      s.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      await s.suspend.execute(admin, { sellerId: SELLER, reason: REASON });

      await expect(
        mailFor(s, 'approved', (approved.ok && approved.value.decisionId) as Id),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'seller-access-mail.skipped', reason: 'decision.superseded' },
      });
      expect(s.fakes.mails).toEqual([]);
    });

    it.each([
      [
        'owner.none',
        (s: Setup) => {
          const owner = [...s.fakes.assignments.values()].find((a) => a.accountId === OWNER)!;
          s.fakes.assignments.delete(owner.id);
        },
      ],
      [
        'account.disabled',
        (s: Setup) => {
          s.fakes.accounts.set(OWNER, { ...s.fakes.accounts.get(OWNER)!, status: 'disabled' });
        },
      ],
    ])('skips the mail with %s', async (reason, change) => {
      const s = setUp();
      await seeded(s, 'pending');
      const approved = await s.approve.execute(admin, { sellerId: SELLER, basisId: null });
      change(s);

      await expect(
        mailFor(s, 'approved', (approved.ok && approved.value.decisionId) as Id),
      ).resolves.toEqual({ ok: true, value: { code: 'seller-access-mail.skipped', reason } });
      expect(s.fakes.mails).toEqual([]);
    });

    it('serves no status page to a suspended seller: the reason reaches staff nowhere', async () => {
      const s = setUp();
      await seeded(s, 'approved');
      await s.suspend.execute(admin, { sellerId: SELLER, reason: REASON });

      // The gate refuses every actor of a suspended seller; the owner reads the reason only in
      // the mail and the sign-in refusal (test/admin-sellers.e2e.spec.ts: staff get the code).
      for (const accountId of [OWNER, STAFF]) {
        const answer = await s.status.execute(sellerActorOf(accountId), {});
        expect(answer.ok).toBe(false);
        expect(JSON.stringify(answer)).not.toContain('food-safety');
      }
    });
  });
});
