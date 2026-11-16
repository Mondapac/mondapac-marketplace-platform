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
import { AssignAdminRole } from '../use-cases/assign-admin-role.use-case';
import { DisableAdminAccount } from '../use-cases/disable-admin-account.use-case';
import { EditPlatformRole } from '../use-cases/edit-platform-role.use-case';
import { EnableAdminAccount } from '../use-cases/enable-admin-account.use-case';
import { ListAdminTeam } from '../use-cases/list-admin-team.use-case';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import {
  AdminRolesReverter,
  AdminStatusReverter,
  PlatformRoleReverter,
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

const ROOT = accountId(1);
const CHECKER = accountId(2);
const MEMBER = accountId(3);
const OFF = accountId(4);
const UNKNOWN = accountId(99);

const NARROW_KEYS = ['identity.admin-account.view'];
const WIDE_KEYS = ['identity.admin-account.view', 'identity.platform-role.view'];

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
    return {
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
      roleReverter: new PlatformRoleReverter(reverters),
      rolesReverter: new AdminRolesReverter(reverters),
      statusReverter: new AdminStatusReverter(reverters),
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

    it('needs a signed-in admin acting as themselves', async () => {
      const { statusReverter } = setUp();
      const system = testCallContext(market, 'system', 'people-review-0002');
      await expect(
        statusReverter.revert(system, request(OFF, { status: 'disabled' }, { status: 'active' })),
      ).rejects.toThrow(/signed-in admin/);
    });
  });
});
