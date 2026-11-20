import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
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
import { RecordingReview } from '../../../../../test/support/system-request-fakes';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import { openSession } from '../../domain/session';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { ThrottleKeys } from '../ports/session-secrets';
import { AssignAdminRole } from '../use-cases/assign-admin-role.use-case';
import { CreatePlatformRole } from '../use-cases/create-platform-role.use-case';
import { DeletePlatformRole } from '../use-cases/delete-platform-role.use-case';
import { InviteAdmin } from '../use-cases/invite-admin.use-case';
import { ChangeActorLabels } from '../use-cases/change-actor-labels.use-case';
import { DisableAdminAccount } from '../use-cases/disable-admin-account.use-case';
import { EditPlatformRole } from '../use-cases/edit-platform-role.use-case';
import { EnableAdminAccount } from '../use-cases/enable-admin-account.use-case';
import { ListAdminTeam } from '../use-cases/list-admin-team.use-case';
import { ListPlatformRoles } from '../use-cases/list-platform-roles.use-case';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import {
  AdminInvitationReverter,
  PlatformRoleCreationReverter,
  PlatformRoleDeletionApplier,
  type PeopleCreationDependencies,
} from './people-creations';
import { INVITE_ADMIN_KEYS, SensitiveAdminInvitationApplier } from './people-invitations';
import {
  AdminRolesReverter,
  AdminStatusReverter,
  PlatformRoleReverter,
  type PeopleLabelReads,
  type PeopleReverterDependencies,
} from './people-reverters';

// Admin Inbox › System requests, area people (owner decisions of 15 Nov 2026): a role edit, an
// admin's role change and an admin's enabling open a high-risk review in their own unit with the
// values before and after; a missing note where the area is reviewed is the use case's own
// validation failure; a disable opens nothing. The reverters restore only what narrows access
// (Hassan: a revert never adds a key, a role or enables an admin), keep the last Platform
// Administrator, and answer changed-since and gone. Identity's stores as fakes; both Markets.

const START = Temporal.Instant.from('2026-11-15T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const REQUEST = id<'SystemRequest'>('01990000-0000-7000-8000-00000000d001');
const NARROW = id<'Role'>('01990000-0000-7000-8000-00000000c0a1');
const WIDE = id<'Role'>('01990000-0000-7000-8000-00000000c0a2');
const GONE_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0ff');
/** A custom role with a protected key (R11): sensitive (owner decision of 18 Nov 2026). */
const SENSITIVE = id<'Role'>('01990000-0000-7000-8000-00000000c0a3');

const ROOT = accountId(1);
const CHECKER = accountId(2);
const MEMBER = accountId(3);
const OFF = accountId(4);
const UNKNOWN = accountId(99);
const SHOPPER = accountId(5);
const ELSEWHERE = accountId(6);

/** Throttle keys in the clear: the counters are told apart by Market, population and address. */
const throttleKeys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
const INVITEE = 'Invitee.Person@example.com';

const NARROW_KEYS = ['identity.admin-account.view'];
const WIDE_KEYS = ['identity.admin-account.view', 'identity.platform-role.view'];
const SENSITIVE_KEYS = ['identity.admin-account.invite', 'identity.admin-account.view'];

describe.each(TEST_MARKETS)('people reviews in market %s (System requests)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  let fakes: IdentityFakes;
  let review: RecordingReview;
  let seeded: Map<string, RoleState>;

  const as = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account,
        sessionId: id<'Session'>('01990000-0000-7000-8000-00000000f001'),
        sellerId: null,
      }),
      'people-review-0001',
    );
  const roleOf = (seedCode: string) => seeded.get(seedCode)!.id;
  const roleIdOf = (account: Id<'Account'>) =>
    [...fakes.assignments.values()].find((a) => a.accountId === account)!.roleId;
  const statusOf = (account: Id<'Account'>) => fakes.accounts.get(account)!.status;
  const keysOf = (role: Id<'Role'>) => fakes.roles.get(role)!.permissionKeys;

  function setUp(options: { readonly reviewed?: boolean } = {}) {
    fakes = new IdentityFakes();
    review = new RecordingReview();
    if (options.reviewed !== false) review.review('people', 'high');
    seeded = new Map();
    new CheckedInRoleSeed().roles().forEach((role, n) => {
      if (role.scope !== 'platform') return;
      const state: RoleState = {
        id: id<'Role'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`),
        marketId,
        scope: role.scope,
        kind: role.kind,
        seedCode: role.seedCode,
        seedVersion: role.seedVersion,
        sellerId: null,
        permissionKeys: role.kind === 'system' ? [] : [...role.permissionKeys].sort(),
        version: 1,
        createdAt: START,
      };
      fakes.seedRole(state);
      seeded.set(role.seedCode, state);
    });
    const custom = (roleId: Id<'Role'>, name: string, keys: readonly string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name,
        permissionKeys: [...keys],
        version: 1,
        createdAt: START,
      });
    custom(NARROW, 'Narrow', NARROW_KEYS);
    custom(WIDE, 'Wide', WIDE_KEYS);
    custom(SENSITIVE, 'Sensitive', SENSITIVE_KEYS);
    const admin = (n: number, account: Id<'Account'>, roleId: Id<'Role'>, active = true) => {
      fakes.seedAccount({
        id: account,
        marketId,
        population: 'admin',
        email: { typed: `p${n}@example.com`, normalized: `p${n}@example.com` },
        displayName: `Admin ${n}`,
        status: active ? 'active' : 'disabled',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: account,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, roleOf('platform-administrator'));
    admin(2, CHECKER, roleOf('platform-administrator'));
    admin(3, MEMBER, NARROW);
    admin(4, OFF, NARROW, false);
    const otherMarket = TEST_MARKETS.find((other) => other !== code)!;
    // Not an admin of this Market: a customer here, and an admin of the other Market.
    for (const [n, account, population, home] of [
      [5, SHOPPER, 'customer', marketId],
      [6, ELSEWHERE, 'admin', otherMarket],
    ] as const) {
      fakes.seedAccount({
        id: account,
        marketId: home as AccountState['marketId'],
        population,
        email: { typed: `p${n}@example.com`, normalized: `p${n}@example.com` },
        displayName: `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    }

    const clock = new FixedClock(START);
    const permissions = realPermissionRegistry();
    const effectiveKeys = realEffectiveKeys(permissions);
    const gate = createUseCaseGate(
      markets,
      new AccountAuthorisationCheck({
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        sellerAccess: fakes.sellerAccessRepository,
        grants: fakes.grantReader,
        effectiveKeys,
      }),
    );
    const common = {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      roles: fakes.roleRepository,
      assignments: fakes.assignmentRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      outbox: fakes.outbox,
      audit: fakes.audit,
      review,
      clock,
    };
    const status = {
      ...common,
      sessions: fakes.sessionRepository,
      challenges: fakes.challengeRepository,
    };
    const reverters: PeopleReverterDependencies = {
      accounts: fakes.accountRepository,
      roles: fakes.roleRepository,
      assignments: fakes.assignmentRepository,
      effectiveKeys,
      permissions,
      sessions: fakes.sessionRepository,
      challenges: fakes.challengeRepository,
      outbox: fakes.outbox,
      audit: fakes.audit,
      clock,
    };
    const creations: PeopleCreationDependencies = {
      ...reverters,
      unitOfWork: fakes.unitOfWork,
      invitations: fakes.invitationRepository,
      grants: fakes.grantReader,
      policy: new MarketConfigIdentityPolicy(markets),
    };
    const labels: PeopleLabelReads = {
      adminNames: new ChangeActorLabels(gate, {
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        grants: fakes.grantReader,
        effectiveKeys,
      }),
      platformRoles: new ListPlatformRoles(gate, { ...common, permissions }),
    };
    return {
      labels,
      assign: new AssignAdminRole(gate, { ...common, permissions }),
      edit: new EditPlatformRole(gate, {
        ...common,
        permissions,
        policy: { customRoleLimit: () => 20 },
        ids: new SequenceIdGenerator(clock),
      }),
      enable: new EnableAdminAccount(gate, status),
      disable: new DisableAdminAccount(gate, status),
      list: new ListAdminTeam(gate, {
        ...common,
        adminAccounts: fakes.adminAccountReader,
        invitations: fakes.invitationRepository,
        permissions,
        factors: fakes.factorRepository,
        policy: new MarketConfigIdentityPolicy(markets),
      }),
      reverters,
      create: new CreatePlatformRole(gate, {
        ...common,
        permissions,
        policy: { customRoleLimit: () => 20 },
        ids: new SequenceIdGenerator(clock),
      }),
      remove: new DeletePlatformRole(gate, {
        ...common,
        proposer: review,
        permissions,
        policy: { customRoleLimit: () => 20 },
        ids: new SequenceIdGenerator(clock),
      }),
      invite: new InviteAdmin(gate, {
        ...common,
        proposer: review,
        permissions,
        invitations: fakes.invitationRepository,
        throttles: fakes.throttleRepository,
        keys: throttleKeys,
        policy: new MarketConfigIdentityPolicy(markets),
        ids: new SequenceIdGenerator(clock),
      }),
      creationReverter: new PlatformRoleCreationReverter(creations, labels),
      invitationReverter: new AdminInvitationReverter(creations, labels),
      deletionApplier: new PlatformRoleDeletionApplier(creations, labels),
      sensitiveApplier: new SensitiveAdminInvitationApplier(creations),
      clock,
      roleReverter: new PlatformRoleReverter(reverters, labels),
      rolesReverter: new AdminRolesReverter(reverters, labels),
      statusReverter: new AdminStatusReverter(reverters, labels),
    };
  }

  describe('opening a review', () => {
    it("opens a high-risk request for an admin's role change, with the role ids before and after", async () => {
      const { assign } = setUp();
      const result = await assign.execute(as(ROOT), {
        accountId: MEMBER,
        roleId: WIDE,
        note: 'Needs the role list',
      });
      expect(result).toMatchObject({
        ok: true,
        value: { code: 'role.assigned', request: { number: 1 } },
      });
      expect(review.opened).toEqual([
        {
          area: 'people',
          subjectKind: 'identity.admin-roles',
          subjectRef: MEMBER,
          before: { roleIds: [NARROW] },
          after: { roleIds: [WIDE] },
          note: 'Needs the role list',
          risk: 'high',
        },
      ]);
    });

    it('refuses a role change without a note where people is reviewed, and opens nothing', async () => {
      const { assign } = setUp();
      expect(await assign.execute(as(ROOT), { accountId: MEMBER, roleId: WIDE })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
      });
      expect(review.opened).toEqual([]);
    });

    it('opens nothing where the Market does not review people, and answers request null', async () => {
      const { assign } = setUp({ reviewed: false });
      const result = await assign.execute(as(ROOT), { accountId: MEMBER, roleId: WIDE });
      expect(result).toMatchObject({ ok: true, value: { code: 'role.assigned', request: null } });
      expect(review.opened).toEqual([]);
    });

    it("opens a high-risk request for a custom role's edit, with its name and keys", async () => {
      const { edit } = setUp();
      const result = await edit.execute(as(ROOT), {
        roleId: NARROW,
        name: 'Narrow plus',
        permissionKeys: WIDE_KEYS,
        expectedVersion: 1,
        note: 'Add the role list',
      });
      expect(result).toMatchObject({
        ok: true,
        value: { code: 'role.updated', request: { number: 1 } },
      });
      expect(review.opened).toEqual([
        {
          area: 'people',
          subjectKind: 'identity.platform-role',
          subjectRef: NARROW,
          before: { name: 'Narrow', permissionKeys: NARROW_KEYS },
          after: { name: 'Narrow plus', permissionKeys: WIDE_KEYS },
          note: 'Add the role list',
          risk: 'high',
        },
      ]);
      expect(
        await edit.execute(as(ROOT), {
          roleId: WIDE,
          name: 'Wide',
          permissionKeys: NARROW_KEYS,
          expectedVersion: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('opens a request for an enabling, never for a disable (a stop needs no note)', async () => {
      const { enable, disable } = setUp();
      const enabled = await enable.execute(as(ROOT), { accountId: OFF, note: 'Back from leave' });
      expect(enabled).toMatchObject({
        ok: true,
        value: { code: 'account.enabled', request: { number: 1 } },
      });
      expect(review.opened).toEqual([
        {
          area: 'people',
          subjectKind: 'identity.admin-status',
          subjectRef: OFF,
          before: { status: 'disabled' },
          after: { status: 'active' },
          note: 'Back from leave',
          risk: 'high',
        },
      ]);
      const disabled = await disable.execute(as(ROOT), { accountId: OFF });
      expect(disabled).toMatchObject({
        ok: true,
        value: { code: 'account.disabled', request: null },
      });
      expect(review.opened).toHaveLength(1);
      // An enabling without a note is refused (the DB spec shows its unit keeps nothing).
      expect(await enable.execute(as(ROOT), { accountId: OFF })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
      });
      expect(review.opened).toHaveLength(1);
    });

    it('tells the team page whether people changes are reviewed', async () => {
      const { list } = setUp();
      const page = await list.execute(as(ROOT), { after: null, limit: 10 });
      expect(page.ok && page.value.review).toEqual({ reviewed: true, risk: 'high' });
      expect(review.asked).toEqual(['people']);
    });
  });

  describe('reverting', () => {
    const request = (subjectRef: string, before: object, after: object) => ({
      requestId: REQUEST,
      subjectRef,
      before: before as Record<string, never>,
      after: after as Record<string, never>,
    });

    it('restores a role edit that added keys, audited with the request; then changed-since', async () => {
      const { edit, roleReverter } = setUp();
      await edit.execute(as(ROOT), {
        roleId: NARROW,
        name: 'Narrow plus',
        permissionKeys: WIDE_KEYS,
        expectedVersion: 1,
        note: 'Add',
      });
      const opened = review.opened[0]!;
      const revert = request(NARROW, opened.before, opened.after);
      fakes.audits.length = 0;
      expect(await roleReverter.revert(as(CHECKER), revert)).toBe('reverted');
      expect(fakes.roles.get(NARROW)).toMatchObject({
        name: 'Narrow',
        permissionKeys: NARROW_KEYS,
      });
      expect(fakes.audits).toMatchObject([
        {
          action: 'identity.role.reverted',
          targetId: NARROW,
          after: {
            scope: 'platform',
            removedKeys: ['identity.platform-role.view'],
            renamed: true,
            requestId: REQUEST,
          },
        },
      ]);
      expect(fakes.events.at(-1)?.type).toBe('identity.role-updated.v1');
      expect(await roleReverter.revert(as(CHECKER), revert)).toBe('changed-since');
    });

    it('never adds a key back to a role: not-permitted, nothing written', async () => {
      const { edit, roleReverter } = setUp();
      await edit.execute(as(ROOT), {
        roleId: WIDE,
        name: 'Wide',
        permissionKeys: NARROW_KEYS,
        expectedVersion: 1,
        note: 'Remove',
      });
      const opened = review.opened[0]!;
      const audits = fakes.audits.length;
      expect(
        await roleReverter.revert(as(CHECKER), request(WIDE, opened.before, opened.after)),
      ).toBe('not-permitted');
      expect(keysOf(WIDE)).toEqual(NARROW_KEYS);
      expect(fakes.audits).toHaveLength(audits);
    });

    it('answers gone for a deleted or seeded role and a malformed value', async () => {
      const { roleReverter } = setUp();
      const values = { name: 'Narrow', permissionKeys: NARROW_KEYS };
      expect(await roleReverter.revert(as(CHECKER), request(GONE_ROLE, values, values))).toBe(
        'gone',
      );
      expect(
        await roleReverter.revert(as(CHECKER), request(roleOf('viewer'), values, values)),
      ).toBe('gone');
      expect(
        await roleReverter.revert(
          as(CHECKER),
          request(NARROW, { name: '', permissionKeys: [] }, values),
        ),
      ).toBe('gone');
    });

    it("restores an admin's narrower role; never a wider one or the Platform Administrator role", async () => {
      const { assign, rolesReverter } = setUp();
      await assign.execute(as(ROOT), { accountId: MEMBER, roleId: WIDE, note: 'Up' });
      const up = review.opened[0]!;
      expect(await rolesReverter.revert(as(CHECKER), request(MEMBER, up.before, up.after))).toBe(
        'reverted',
      );
      expect(roleIdOf(MEMBER)).toBe(NARROW);
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.account-role.reverted',
        targetId: MEMBER,
        before: { roleId: WIDE },
        after: { roleId: NARROW, scope: 'platform', requestId: REQUEST },
      });
      expect(await rolesReverter.revert(as(CHECKER), request(MEMBER, up.before, up.after))).toBe(
        'changed-since',
      );

      // A demotion's revert would widen access: it waits for a person.
      const down = request(MEMBER, { roleIds: [WIDE] }, { roleIds: [NARROW] });
      expect(await rolesReverter.revert(as(CHECKER), down)).toBe('not-permitted');
      const toAdmin = request(
        MEMBER,
        { roleIds: [roleOf('platform-administrator')] },
        { roleIds: [NARROW] },
      );
      expect(await rolesReverter.revert(as(CHECKER), toAdmin)).toBe('not-permitted');
      expect(roleIdOf(MEMBER)).toBe(NARROW);
      const gone = request(MEMBER, { roleIds: [GONE_ROLE] }, { roleIds: [NARROW] });
      expect(await rolesReverter.revert(as(CHECKER), gone)).toBe('gone');
      expect(await rolesReverter.revert(as(CHECKER), request(UNKNOWN, up.before, up.after))).toBe(
        'gone',
      );
    });

    it('keeps the last Platform Administrator when a promotion is reverted', async () => {
      const { assign, disable, rolesReverter } = setUp();
      await assign.execute(as(ROOT), {
        accountId: MEMBER,
        roleId: roleOf('platform-administrator'),
        note: 'Cover',
      });
      const promoted = review.opened[0]!;
      const revert = request(MEMBER, promoted.before, promoted.after);
      // Two other administrators can sign in: the revert demotes.
      await disable.execute(as(MEMBER), { accountId: ROOT });
      await disable.execute(as(MEMBER), { accountId: CHECKER });
      expect(await rolesReverter.revert(as(CHECKER), revert)).toBe('not-permitted');
      expect(roleIdOf(MEMBER)).toBe(roleOf('platform-administrator'));
    });

    it('disables again an admin whose enabling is reverted, ending every session', async () => {
      const { enable, statusReverter } = setUp();
      await enable.execute(as(ROOT), { accountId: OFF, note: 'Back' });
      void fakes.sessionRepository.add(
        market,
        openSession({
          id: id<'Session'>('01990000-0000-7000-8000-00000000f101'),
          marketId,
          accountId: OFF,
          population: 'admin',
          transport: 'cookie',
          lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
          now: START,
        }),
        new Uint8Array(32).fill(7),
      );
      const opened = review.opened[0]!;
      const revert = request(OFF, opened.before, opened.after);
      expect(await statusReverter.revert(as(CHECKER), revert)).toBe('reverted');
      expect(statusOf(OFF)).toBe('disabled');
      const sessions = [...fakes.sessions.values()].filter((s) => s.session.accountId === OFF);
      expect(sessions.map((s) => s.session.revokedReason)).toEqual(['account-disabled']);
      expect(fakes.credentialLocks.at(-1)).toBe(OFF);
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.account-status.reverted',
        targetId: OFF,
        before: { status: 'active' },
        after: { status: 'disabled', population: 'admin', requestId: REQUEST },
      });
      expect(await statusReverter.revert(as(CHECKER), revert)).toBe('changed-since');
    });

    it('never enables an account, and answers gone for an unknown one', async () => {
      const { statusReverter } = setUp();
      const enableBack = request(OFF, { status: 'active' }, { status: 'disabled' });
      expect(await statusReverter.revert(as(CHECKER), enableBack)).toBe('not-permitted');
      expect(statusOf(OFF)).toBe('disabled');
      const off = request(UNKNOWN, { status: 'disabled' }, { status: 'active' });
      expect(await statusReverter.revert(as(CHECKER), off)).toBe('gone');
    });

    it('never disables the last Platform Administrator who can sign in', async () => {
      const { disable, statusReverter } = setUp();
      await disable.execute(as(ROOT), { accountId: CHECKER });
      const revert = request(ROOT, { status: 'disabled' }, { status: 'active' });
      expect(await statusReverter.revert(as(CHECKER), revert)).toBe('not-permitted');
      expect(statusOf(ROOT)).toBe('active');
    });

    it('drops a key the catalogue no longer declares from the value before, and still reverts', async () => {
      const { edit, roleReverter } = setUp();
      await edit.execute(as(ROOT), {
        roleId: NARROW,
        name: 'Narrow plus',
        permissionKeys: WIDE_KEYS,
        expectedVersion: 1,
        note: 'Add',
      });
      const opened = review.opened[0]!;
      const before = { name: 'Narrow', permissionKeys: [...NARROW_KEYS, 'identity.retired.key'] };
      expect(await roleReverter.revert(as(CHECKER), request(NARROW, before, opened.after))).toBe(
        'reverted',
      );
      expect(fakes.roles.get(NARROW)).toMatchObject({
        name: 'Narrow',
        permissionKeys: NARROW_KEYS,
      });
    });

    it('marks the decider as interested in a change to their own account or held role', async () => {
      const { roleReverter, rolesReverter, statusReverter } = setUp();
      const roles = request(MEMBER, { roleIds: [NARROW] }, { roleIds: [WIDE] });
      expect(await rolesReverter.isInterested(as(MEMBER), roles)).toBe(true);
      expect(await rolesReverter.isInterested(as(CHECKER), roles)).toBe(false);
      const status = request(OFF, { status: 'disabled' }, { status: 'active' });
      expect(await statusReverter.isInterested(as(OFF), status)).toBe(true);
      expect(await statusReverter.isInterested(as(CHECKER), status)).toBe(false);
      const values = { name: 'Narrow', permissionKeys: NARROW_KEYS };
      // MEMBER holds NARROW now; CHECKER holds the Platform Administrator role.
      expect(await roleReverter.isInterested(as(MEMBER), request(NARROW, values, values))).toBe(
        true,
      );
      expect(await roleReverter.isInterested(as(CHECKER), request(NARROW, values, values))).toBe(
        false,
      );
      expect(
        await roleReverter.isInterested(
          as(CHECKER),
          request(roleOf('platform-administrator'), values, values),
        ),
      ).toBe(true);
      // Fail closed: an actor that is not a signed-in admin counts as interested.
      const system = testCallContext(market, 'system', 'people-review-0003');
      expect(await statusReverter.isInterested(system, status)).toBe(true);
      expect(await roleReverter.isInterested(system, request(NARROW, values, values))).toBe(true);
    });

    it('needs a signed-in admin acting as themselves', async () => {
      const { statusReverter } = setUp();
      const system = testCallContext(market, 'system', 'people-review-0002');
      await expect(
        statusReverter.revert(system, request(OFF, { status: 'disabled' }, { status: 'active' })),
      ).rejects.toThrow(/signed-in admin/);
    });
  });

  describe('creations reviewed after, and the delete that waits for approval (18 Nov 2026)', () => {
    const request = (subjectRef: string, before: object, after: object) => ({
      requestId: REQUEST,
      subjectRef,
      before: before as Record<string, never>,
      after: after as Record<string, never>,
    });
    const created = async (
      create: CreatePlatformRole,
      keys: readonly string[] = NARROW_KEYS,
      name = 'Support desk',
    ) => {
      const result = await create.execute(as(ROOT), {
        name,
        permissionKeys: [...keys],
        note: 'For the support desk',
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    };

    it('opens a high-risk review for a created role; without a note it is refused', async () => {
      const { create } = setUp();
      expect(
        await create.execute(as(ROOT), { name: 'Unnoted', permissionKeys: NARROW_KEYS }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
      });
      const role = await created(create, WIDE_KEYS);
      expect(role).toMatchObject({ code: 'role.created', request: { number: 1 } });
      expect(review.opened).toEqual([
        {
          area: 'people',
          subjectKind: 'identity.platform-role-creation',
          subjectRef: role.roleId,
          before: { exists: false },
          after: { exists: true, name: 'Support desk', permissionKeys: WIDE_KEYS },
          note: 'For the support desk',
          risk: 'high',
        },
      ]);
    });

    it('creates at once and opens nothing where the Market does not review people', async () => {
      const { create, invite, remove } = setUp({ reviewed: false });
      const role = await create.execute(as(ROOT), { name: 'Free', permissionKeys: NARROW_KEYS });
      expect(role).toMatchObject({ ok: true, value: { code: 'role.created', request: null } });
      const invited = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: NARROW,
        origin: '203.0.113.9',
      });
      expect(invited).toMatchObject({ ok: true, value: { request: null } });
      const removed = await remove.execute(as(ROOT), {
        roleId: role.ok ? role.value.roleId : GONE_ROLE,
        expectedVersion: 1,
      });
      expect(removed).toMatchObject({ ok: true, value: { code: 'role.deleted', request: null } });
      expect(review.opened).toEqual([]);
      expect(review.proposed).toEqual([]);
    });

    it("deletes again a rejected role nobody holds, audited with the request; never one that's held or changed", async () => {
      const { create, creationReverter, assign, edit } = setUp();
      const role = await created(create);
      const opened = review.opened[0]!;
      const revert = request(role.roleId, opened.before, opened.after);

      // Held: refused, nothing written.
      await assign.execute(as(ROOT), { accountId: MEMBER, roleId: role.roleId, note: 'Try it' });
      const audits = fakes.audits.length;
      expect(await creationReverter.revert(as(CHECKER), revert)).toBe('not-permitted');
      expect(fakes.roles.get(role.roleId)).toBeDefined();
      expect(fakes.audits).toHaveLength(audits);
      await assign.execute(as(ROOT), { accountId: MEMBER, roleId: NARROW, note: 'Back' });

      // Its keys changed since: changed-since; a rename alone does not matter.
      await edit.execute(as(ROOT), {
        roleId: role.roleId,
        name: 'Support desk 2',
        permissionKeys: WIDE_KEYS,
        expectedVersion: 1,
        note: 'More',
      });
      expect(await creationReverter.revert(as(CHECKER), revert)).toBe('changed-since');
      await edit.execute(as(ROOT), {
        roleId: role.roleId,
        name: 'Support desk 3',
        permissionKeys: NARROW_KEYS,
        expectedVersion: 2,
        note: 'Less',
      });

      expect(await creationReverter.revert(as(CHECKER), revert)).toBe('reverted');
      expect(fakes.roles.get(role.roleId)).toBeUndefined();
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.role.creation-reverted',
        targetId: role.roleId,
        before: { scope: 'platform', removedKeys: NARROW_KEYS },
        after: { requestId: REQUEST },
      });
      expect(fakes.events.at(-1)?.type).toBe('identity.role-deleted.v1');
      expect(await creationReverter.revert(as(CHECKER), revert)).toBe('gone');
      // A seeded role is never deleted by a revert.
      expect(
        await creationReverter.revert(
          as(CHECKER),
          request(roleOf('viewer'), opened.before, opened.after),
        ),
      ).toBe('gone');
    });

    it('opens a review for an invitation without the address, and revokes it while pending', async () => {
      const { invite, invitationReverter } = setUp();
      const refused = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: NARROW,
        origin: '203.0.113.9',
      });
      expect(refused).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      fakes.invitations.clear();
      const invited = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: NARROW,
        origin: '203.0.113.9',
        note: 'Joins support',
      });
      if (!invited.ok) throw new Error(JSON.stringify(invited.error));
      expect(invited.value.request).toMatchObject({ number: 1 });
      const opened = review.opened[0]!;
      expect(opened).toEqual({
        area: 'people',
        subjectKind: 'identity.admin-invitation',
        subjectRef: invited.value.invitationId,
        before: { exists: false },
        after: { exists: true, roleId: NARROW },
        note: 'Joins support',
        risk: 'high',
      });
      expect(JSON.stringify(review.opened).toLowerCase()).not.toContain(INVITEE.toLowerCase());

      const revert = request(invited.value.invitationId, opened.before, opened.after);
      // The invitee may not decide their own invitation; another admin may.
      const invitee = accountId(7);
      fakes.seedAccount({
        ...fakes.accounts.get(MEMBER)!,
        id: invitee,
        email: { typed: INVITEE, normalized: INVITEE.toLowerCase() },
      });
      expect(await invitationReverter.isInterested(as(invitee), revert)).toBe(true);
      expect(await invitationReverter.isInterested(as(CHECKER), revert)).toBe(false);

      expect(await invitationReverter.revert(as(CHECKER), revert)).toBe('reverted');
      expect(fakes.invitations.get(invited.value.invitationId)).toMatchObject({
        state: 'revoked',
        email: null,
      });
      expect(fakes.invitationLocks.at(-1)).toBe(invited.value.invitationId);
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.invitation.reverted',
        targetId: invited.value.invitationId,
        after: { kind: 'admin', roleId: NARROW, requestId: REQUEST },
      });
      expect(JSON.stringify(fakes.audits).toLowerCase()).not.toContain(INVITEE.toLowerCase());
      expect(await invitationReverter.revert(as(CHECKER), revert)).toBe('changed-since');
    });

    it('disables the admin who accepted a rejected invitation, ending its sessions; keeps the last Platform Administrator', async () => {
      const { invite, invitationReverter, disable } = setUp();
      const invited = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: NARROW,
        origin: '203.0.113.9',
        note: 'Joins support',
      });
      if (!invited.ok) throw new Error(JSON.stringify(invited.error));
      const invitationId = invited.value.invitationId;
      const accept = (account: Id<'Account'>) =>
        fakes.invitations.set(invitationId, {
          ...fakes.invitations.get(invitationId)!,
          state: 'accepted',
          email: null,
          decidedAt: START,
          acceptedAccountId: account,
        });
      accept(MEMBER);
      void fakes.sessionRepository.add(
        market,
        openSession({
          id: id<'Session'>('01990000-0000-7000-8000-00000000f201'),
          marketId,
          accountId: MEMBER,
          population: 'admin',
          transport: 'cookie',
          lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
          now: START,
        }),
        new Uint8Array(32).fill(9),
      );
      const opened = review.opened[0]!;
      const revert = request(invitationId, opened.before, opened.after);
      expect(await invitationReverter.isInterested(as(MEMBER), revert)).toBe(true);
      expect(await invitationReverter.revert(as(CHECKER), revert)).toBe('reverted');
      expect(statusOf(MEMBER)).toBe('disabled');
      const sessions = [...fakes.sessions.values()].filter((s) => s.session.accountId === MEMBER);
      expect(sessions.map((s) => s.session.revokedReason)).toEqual(['account-disabled']);
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.account-status.reverted',
        targetId: MEMBER,
        after: { status: 'disabled', population: 'admin', requestId: REQUEST },
      });
      expect(await invitationReverter.revert(as(CHECKER), revert)).toBe('changed-since');

      // Accepted by the only Platform Administrator who can still sign in: refused.
      accept(ROOT);
      await disable.execute(as(ROOT), { accountId: CHECKER });
      expect(await invitationReverter.revert(as(CHECKER), revert)).toBe('not-permitted');
      expect(statusOf(ROOT)).toBe('active');
      // Gone: unknown invitation, or values that are not this invitation's.
      expect(
        await invitationReverter.revert(as(CHECKER), request(REQUEST, opened.before, opened.after)),
      ).toBe('gone');
      expect(
        await invitationReverter.revert(
          as(CHECKER),
          request(invitationId, opened.before, { exists: true, roleId: WIDE }),
        ),
      ).toBe('gone');
    });

    it('answers changed-since for an invitation revoked meanwhile or an account no longer active, and gone once purged', async () => {
      const { invite, invitationReverter, disable } = setUp();
      const issue = async (email: string) => {
        const invited = await invite.execute(as(ROOT), {
          email,
          roleId: NARROW,
          origin: '203.0.113.9',
          note: 'Joins support',
        });
        if (!invited.ok) throw new Error(JSON.stringify(invited.error));
        const opened = review.opened.at(-1)!;
        return {
          invitationId: invited.value.invitationId,
          revert: request(invited.value.invitationId, opened.before, opened.after),
        };
      };

      // Revoked by the inviter's side meanwhile: changed-since, nothing written.
      const revoked = await issue('revoked.person@example.com');
      fakes.invitations.set(revoked.invitationId, {
        ...fakes.invitations.get(revoked.invitationId)!,
        state: 'revoked',
        email: null,
        decidedAt: START,
      });
      const audits = fakes.audits.length;
      expect(await invitationReverter.revert(as(CHECKER), revoked.revert)).toBe('changed-since');
      expect(fakes.audits).toHaveLength(audits);

      // Accepted by an account that is disabled since: changed-since, nothing written.
      const inactive = await issue('inactive.person@example.com');
      fakes.invitations.set(inactive.invitationId, {
        ...fakes.invitations.get(inactive.invitationId)!,
        state: 'accepted',
        email: null,
        decidedAt: START,
        acceptedAccountId: MEMBER,
      });
      await disable.execute(as(ROOT), { accountId: MEMBER });
      const before = fakes.audits.length;
      expect(await invitationReverter.revert(as(CHECKER), inactive.revert)).toBe('changed-since');
      expect(fakes.audits).toHaveLength(before);
      expect(statusOf(MEMBER)).toBe('disabled');

      // Purged (the row is gone): gone, nothing written.
      const purged = await issue('purged.person@example.com');
      fakes.invitations.delete(purged.invitationId);
      const purgedBefore = fakes.audits.length;
      expect(await invitationReverter.revert(as(CHECKER), purged.revert)).toBe('gone');
      expect(fakes.audits).toHaveLength(purgedBefore);
    });

    it('files a delete for approval and writes nothing; one waits per role', async () => {
      const { create, remove } = setUp();
      const role = await created(create);
      expect(
        await remove.execute(as(ROOT), { roleId: role.roleId, expectedVersion: 1 }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      const proposed = await remove.execute(as(ROOT), {
        roleId: role.roleId,
        expectedVersion: 1,
        note: 'No longer needed',
      });
      expect(proposed).toEqual({
        ok: true,
        value: {
          code: 'role.delete-requested',
          roleId: role.roleId,
          request: { id: expect.any(String) as string, number: 2 },
        },
      });
      expect(fakes.roles.get(role.roleId)).toBeDefined();
      expect(review.proposed).toEqual([
        {
          area: 'people',
          subjectKind: 'identity.platform-role-deletion',
          subjectRef: role.roleId,
          before: { name: 'Support desk', permissionKeys: NARROW_KEYS, version: 1 },
          after: { action: 'delete' },
          note: 'No longer needed',
          risk: 'high',
        },
      ]);
      expect(
        await remove.execute(as(ROOT), {
          roleId: role.roleId,
          expectedVersion: 1,
          note: 'Again',
        }),
      ).toEqual({
        ok: false,
        error: { code: 'system-requests.already-pending', pendingNumber: 2 },
      });
      // The delete's own checks still run first: a held role is refused, nothing filed.
      expect(
        await remove.execute(as(ROOT), { roleId: NARROW, expectedVersion: 1, note: 'Held' }),
      ).toEqual({ ok: false, error: { code: 'role.in-use' } });
      expect(review.proposed).toHaveLength(1);
    });

    it('applies an approved delete only while the role is unchanged and unheld, as the approver', async () => {
      const { create, remove, deletionApplier, assign, edit } = setUp();
      const role = await created(create);
      await remove.execute(as(ROOT), {
        roleId: role.roleId,
        expectedVersion: 1,
        note: 'No longer needed',
      });
      const proposal = review.proposed[0]!;
      const apply = request(role.roleId, proposal.before, proposal.after);

      // The approver's own permission and reach, checked before and in the unit.
      expect(await deletionApplier.check(as(MEMBER), apply)).toBe('not-permitted');
      expect(await deletionApplier.apply(as(MEMBER), apply)).toBe('not-permitted');
      expect(await deletionApplier.check(as(CHECKER), apply)).toBe('ok');
      const system = testCallContext(market, 'system', 'people-review-0010');
      expect(await deletionApplier.check(system, apply)).toBe('not-permitted');

      // Held since: refused.
      await assign.execute(as(ROOT), { accountId: MEMBER, roleId: role.roleId, note: 'Try' });
      expect(await deletionApplier.apply(as(CHECKER), apply)).toBe('not-permitted');
      expect(await deletionApplier.isInterested(as(MEMBER), apply)).toBe(true);
      expect(await deletionApplier.isInterested(as(CHECKER), apply)).toBe(false);
      await assign.execute(as(ROOT), { accountId: MEMBER, roleId: NARROW, note: 'Back' });

      // Changed since (a new version, even with the same keys): refused.
      await edit.execute(as(ROOT), {
        roleId: role.roleId,
        name: 'Renamed',
        permissionKeys: NARROW_KEYS,
        expectedVersion: 1,
        note: 'Rename',
      });
      const audits = fakes.audits.length;
      expect(await deletionApplier.apply(as(CHECKER), apply)).toBe('changed-since');
      expect(fakes.audits).toHaveLength(audits);
      expect(fakes.roles.get(role.roleId)).toBeDefined();

      // Unchanged and unheld: deleted, audited as the approver with the request.
      const fresh = request(
        role.roleId,
        { name: 'Renamed', permissionKeys: NARROW_KEYS, version: 2 },
        { action: 'delete' },
      );
      expect(await deletionApplier.apply(as(CHECKER), fresh)).toBe('applied');
      expect(fakes.roles.get(role.roleId)).toBeUndefined();
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.role.deletion-approved',
        actor: 'authenticated',
        targetId: role.roleId,
        before: { scope: 'platform', removedKeys: NARROW_KEYS },
        after: { requestId: REQUEST },
      });
      expect(fakes.events.at(-1)?.type).toBe('identity.role-deleted.v1');
      expect(await deletionApplier.apply(as(CHECKER), fresh)).toBe('gone');
      // Never a seeded role.
      expect(
        await deletionApplier.apply(
          as(CHECKER),
          request(roleOf('viewer'), fresh.before, fresh.after),
        ),
      ).toBe('gone');
    });

    it('names a created or deleted role and the admin who accepted an invitation; never an address', async () => {
      const { create, invite, creationReverter, deletionApplier, invitationReverter } = setUp();
      const role = await created(create);
      expect(await creationReverter.describe(as(CHECKER), [role.roleId])).toEqual(
        new Map([[role.roleId, 'Support desk']]),
      );
      expect(await deletionApplier.describe(as(CHECKER), [role.roleId])).toEqual(
        new Map([[role.roleId, 'Support desk']]),
      );
      const invited = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: NARROW,
        origin: '203.0.113.9',
        note: 'Joins support',
      });
      if (!invited.ok) throw new Error('not invited');
      const id = invited.value.invitationId;
      // Pending: no label (only an address, never shown).
      expect(await invitationReverter.describe(as(CHECKER), [id])).toEqual(new Map());
      fakes.invitations.set(id, {
        ...fakes.invitations.get(id)!,
        state: 'accepted',
        email: null,
        decidedAt: START,
        acceptedAccountId: MEMBER,
      });
      expect(await invitationReverter.describe(as(CHECKER), [id, 'not-an-id', GONE_ROLE])).toEqual(
        new Map([[id, 'Admin 3']]),
      );
      const system = testCallContext(market, 'system', 'people-review-0011');
      expect(await invitationReverter.describe(system, [id])).toEqual(new Map());
    });
  });

  describe("a sensitive role's invitation waits for approval (owner decision of 18 Nov 2026, 14:06Z)", () => {
    const request = (subjectRef: string, before: object, after: object) => ({
      requestId: REQUEST,
      subjectRef,
      before: before as Record<string, never>,
      after: after as Record<string, never>,
    });
    const issuedEventsOf = (invitationId: string) =>
      fakes.events.filter(
        (event) =>
          event.type === 'identity.invitation-issued.v1' && event.aggregateId === invitationId,
      );
    const lifetime = () =>
      new MarketConfigIdentityPolicy(markets).invitationLifetimeMinutes(market, 'admin')!;

    it('registers the applier with every key of the invite rule', () => {
      const rule = InviteAdmin.access.rule;
      expect(rule.kind === 'permissions' ? rule.allOf : null).toEqual(INVITE_ADMIN_KEYS);
    });

    it.each([
      ['the Platform Administrator', () => roleOf('platform-administrator')],
      ['a custom role with a protected key', () => SENSITIVE],
    ])(
      'files %s for approval: held, nothing sent, no address in the request or the audit',
      async (_name, roleFor) => {
        const { invite } = setUp();
        const roleId = roleFor();
        const result = await invite.execute(as(ROOT), {
          email: INVITEE,
          roleId,
          origin: '203.0.113.9',
          note: 'Second Platform Administrator',
        });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        expect(result.value).toMatchObject({
          code: 'invitation.proposed',
          replaced: false,
          request: { number: 1 },
        });
        const invitationId = result.value.invitationId;
        expect(review.opened).toEqual([]);
        expect(review.proposed).toEqual([
          {
            area: 'people',
            subjectKind: 'identity.admin-invitation-sensitive',
            subjectRef: invitationId,
            before: { roleId, roleVersion: 1 },
            after: { action: 'invite', roleId },
            note: 'Second Platform Administrator',
            risk: 'high',
          },
        ]);
        expect(fakes.invitations.get(invitationId)).toMatchObject({
          state: 'pending',
          heldForApproval: true,
          tokenHash: null,
          expiresAt: null,
          invitedByAccountId: ROOT,
        });
        // No issue event: the mail handler never sees it, so no mail and no token.
        expect(issuedEventsOf(invitationId)).toEqual([]);
        expect(fakes.audits.at(-1)).toMatchObject({
          action: 'identity.invitation.proposed',
          actor: 'authenticated',
          targetId: invitationId,
          after: { kind: 'admin', roleId, requestId: expect.any(String) as string },
        });
        const written = JSON.stringify([review.proposed, fakes.audits]).toLowerCase();
        expect(written).not.toContain(INVITEE.toLowerCase());
      },
    );

    it('issues it at once, as any invitation, where the Market does not review people', async () => {
      const { invite } = setUp({ reviewed: false });
      const result = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: roleOf('platform-administrator'),
        origin: '203.0.113.9',
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(result.value).toMatchObject({ code: 'invitation.issued', request: null });
      expect(fakes.invitations.get(result.value.invitationId)?.heldForApproval).toBe(false);
      expect(issuedEventsOf(result.value.invitationId)).toHaveLength(1);
      expect(review.proposed).toEqual([]);
    });

    it('keeps a non-sensitive role reviewed after, and refuses a sensitive one without a note', async () => {
      const { invite } = setUp();
      expect(
        await invite.execute(as(ROOT), {
          email: INVITEE,
          roleId: SENSITIVE,
          origin: '203.0.113.9',
        }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
      });
      expect(fakes.invitations.size).toBe(0);
      expect(review.proposed).toEqual([]);
      const narrow = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: NARROW,
        origin: '203.0.113.9',
        note: 'Joins support',
      });
      expect(narrow).toMatchObject({ ok: true, value: { code: 'invitation.issued' } });
      expect(review.opened).toHaveLength(1);
      expect(review.proposed).toEqual([]);
    });

    it('answers invitation.already-pending for the same address while one waits', async () => {
      const { invite } = setUp();
      const first = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: SENSITIVE,
        origin: '203.0.113.9',
        note: 'First',
      });
      expect(first).toMatchObject({ ok: true, value: { code: 'invitation.proposed' } });
      expect(
        await invite.execute(as(CHECKER), {
          email: INVITEE.toUpperCase(),
          roleId: roleOf('platform-administrator'),
          origin: '203.0.113.9',
          note: 'Second',
        }),
      ).toEqual({ ok: false, error: { code: 'invitation.already-pending' } });
      expect(review.proposed).toHaveLength(1);
    });

    it('sends it once approved, as the approver, only while R1 and R11 hold for them', async () => {
      const { invite, sensitiveApplier } = setUp();
      const result = await invite.execute(as(ROOT), {
        email: INVITEE,
        roleId: SENSITIVE,
        origin: '203.0.113.9',
        note: 'Joins as inviter',
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const invitationId = result.value.invitationId;
      const proposal = review.proposed[0]!;
      const apply = request(invitationId, proposal.before, proposal.after);

      // MEMBER lacks the invite key; nothing is sent.
      expect(await sensitiveApplier.check(as(MEMBER), apply)).toBe('not-permitted');
      expect(await sensitiveApplier.apply(as(MEMBER), apply)).toBe('not-permitted');
      // MEMBER now holds the invite key, but a protected key needs the system role (R11).
      const membership = [...fakes.assignments.values()].find((a) => a.accountId === MEMBER)!;
      fakes.assignments.set(membership.id, { ...membership, roleId: SENSITIVE });
      expect(await sensitiveApplier.check(as(MEMBER), apply)).toBe('not-permitted');
      expect(await sensitiveApplier.apply(as(MEMBER), apply)).toBe('not-permitted');
      const system = testCallContext(market, 'system', 'people-review-0020');
      expect(await sensitiveApplier.check(system, apply)).toBe('not-permitted');
      expect(issuedEventsOf(invitationId)).toEqual([]);
      expect(fakes.invitations.get(invitationId)?.heldForApproval).toBe(true);

      expect(await sensitiveApplier.isInterested(as(CHECKER), apply)).toBe(false);
      expect(await sensitiveApplier.check(as(CHECKER), apply)).toBe('ok');
      const audits = fakes.audits.length;
      expect(await sensitiveApplier.apply(as(CHECKER), apply)).toBe('applied');
      expect(fakes.invitationLocks.at(-1)).toBe(invitationId);
      expect(fakes.invitations.get(invitationId)).toMatchObject({
        state: 'pending',
        heldForApproval: false,
        version: 2,
        invitedByAccountId: ROOT,
      });
      expect(issuedEventsOf(invitationId)).toEqual([
        expect.objectContaining({ aggregateVersion: 2 }),
      ]);
      expect(fakes.audits).toHaveLength(audits + 1);
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.invitation.approved',
        actor: 'authenticated',
        targetId: invitationId,
        after: { kind: 'admin', roleId: SENSITIVE, requestId: REQUEST },
      });
      expect(JSON.stringify(fakes.audits).toLowerCase()).not.toContain(INVITEE.toLowerCase());
      // Released once: a second approval writes nothing.
      expect(await sensitiveApplier.apply(as(CHECKER), apply)).toBe('changed-since');
      expect(issuedEventsOf(invitationId)).toHaveLength(1);
    });

    it('answers changed-since after a role edit or a revoke, gone once purged or lapsed, and not-permitted once the address has an account', async () => {
      const { invite, edit, sensitiveApplier, clock } = setUp();
      const issue = async (email: string) => {
        const invited = await invite.execute(as(ROOT), {
          email,
          roleId: SENSITIVE,
          origin: '203.0.113.9',
          note: 'Joins as inviter',
        });
        if (!invited.ok) throw new Error(JSON.stringify(invited.error));
        const proposal = review.proposed.at(-1)!;
        return {
          invitationId: invited.value.invitationId,
          apply: request(invited.value.invitationId, proposal.before, proposal.after),
        };
      };
      const sends = () => fakes.events.filter((e) => e.type === 'identity.invitation-issued.v1');

      // Revoked by the inviter's side meanwhile.
      const revoked = await issue('revoked.person@example.com');
      fakes.invitations.set(revoked.invitationId, {
        ...fakes.invitations.get(revoked.invitationId)!,
        state: 'revoked',
        email: null,
        heldForApproval: false,
        decidedAt: START,
      });
      expect(await sensitiveApplier.apply(as(CHECKER), revoked.apply)).toBe('changed-since');

      // The address has an admin account since: acceptance could only fail.
      const taken = await issue('taken.person@example.com');
      fakes.seedAccount({
        ...fakes.accounts.get(MEMBER)!,
        id: accountId(40),
        email: { typed: 'taken.person@example.com', normalized: 'taken.person@example.com' },
      });
      expect(await sensitiveApplier.isInterested(as(accountId(40)), taken.apply)).toBe(true);
      expect(await sensitiveApplier.apply(as(CHECKER), taken.apply)).toBe('not-permitted');

      // Purged: gone.
      const purged = await issue('purged.person@example.com');
      fakes.invitations.delete(purged.invitationId);
      expect(await sensitiveApplier.apply(as(CHECKER), purged.apply)).toBe('gone');

      // The role was edited since it was asked for (a new version).
      const edited = await issue('edited.person@example.com');
      await edit.execute(as(ROOT), {
        roleId: SENSITIVE,
        name: 'Sensitive plus',
        permissionKeys: [...SENSITIVE_KEYS, 'identity.platform-role.view'],
        expectedVersion: 1,
        note: 'Wider',
      });
      expect(await sensitiveApplier.apply(as(CHECKER), edited.apply)).toBe('changed-since');

      // Past the Market's admin invitation lifetime it is a lapsed, never-sent invitation.
      const lapsed = await issue('lapsed.person@example.com');
      clock.advance(Temporal.Duration.from({ minutes: lifetime() }));
      expect(await sensitiveApplier.apply(as(CHECKER), lapsed.apply)).toBe('gone');
      expect(sends()).toEqual([]);
    });
  });

  describe('labels for the queue (describe)', () => {
    it("names this Market's admins by display name, and no one else", async () => {
      const { rolesReverter, statusReverter } = setUp();
      const refs = [MEMBER, OFF, SHOPPER, ELSEWHERE, UNKNOWN, 'not-an-id'];
      const expected = new Map([
        [MEMBER, 'Admin 3'],
        [OFF, 'Admin 4'],
      ]);
      expect(await rolesReverter.describe(as(CHECKER), refs)).toEqual(expected);
      expect(await statusReverter.describe(as(CHECKER), refs)).toEqual(expected);
      // A narrow admin may name admins too (any signed-in admin of the Market).
      expect(await statusReverter.describe(as(MEMBER), [CHECKER])).toEqual(
        new Map([[CHECKER, 'Admin 2']]),
      );
    });

    it('names a custom role only for an admin who may list the platform roles', async () => {
      const { roleReverter } = setUp();
      const refs = [NARROW, WIDE, roleOf('platform-administrator'), GONE_ROLE];
      expect(await roleReverter.describe(as(CHECKER), refs)).toEqual(
        new Map([
          [NARROW, 'Narrow'],
          [WIDE, 'Wide'],
        ]),
      );
      // MEMBER's role lacks identity.platform-role.view: no label.
      expect(await roleReverter.describe(as(MEMBER), refs)).toEqual(new Map());
    });

    it('answers no label on a refusal or a failure, never an error', async () => {
      const { rolesReverter, roleReverter, reverters } = setUp();
      // A disabled admin and the system actor are refused by identity's own reads.
      expect(await rolesReverter.describe(as(OFF), [MEMBER])).toEqual(new Map());
      expect(await roleReverter.describe(as(OFF), [NARROW])).toEqual(new Map());
      const system = testCallContext(market, 'system', 'people-review-0004');
      expect(await rolesReverter.describe(system, [MEMBER])).toEqual(new Map());
      expect(await roleReverter.describe(system, [NARROW])).toEqual(new Map());
      const down: PeopleLabelReads = {
        adminNames: { execute: () => Promise.reject(new Error('down')) },
        platformRoles: { execute: () => Promise.reject(new Error('down')) },
      };
      expect(
        await new AdminStatusReverter(reverters, down).describe(as(CHECKER), [MEMBER]),
      ).toEqual(new Map());
      expect(
        await new PlatformRoleReverter(reverters, down).describe(as(CHECKER), [NARROW]),
      ).toEqual(new Map());
    });
  });
});
