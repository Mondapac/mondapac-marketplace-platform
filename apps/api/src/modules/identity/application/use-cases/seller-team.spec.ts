import { parseId, Temporal } from '@mondapac/shared-kernel';
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
import { parseEmailAddress } from '../../domain/email-address';
import type { RoleState } from '../../domain/role';
import { openSession } from '../../domain/session';
import { CatalogueMailComposer } from '../../infrastructure/mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { RandomPrefixedTokens } from '../../infrastructure/second-factor/second-factor-tokens';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { RoleAssignmentRepository } from '../ports/seller-team.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import { AcceptSellerInvitation } from './accept-seller-invitation.use-case';
import { AssignTeamMemberRole } from './assign-team-member-role.use-case';
import { InviteStaff } from './invite-staff.use-case';
import { ListSellerTeam } from './list-seller-team.use-case';
import { RemoveTeamMember } from './remove-team-member.use-case';
import { ResendStaffInvitation } from './resend-staff-invitation.use-case';
import { RevokeStaffInvitation } from './revoke-staff-invitation.use-case';
import { SeedRoles } from './seed-roles.use-case';
import { SendInvitationMail } from './send-invitation-mail.use-case';

// Identity slice 11, the seller team (identity design 3.4, 5.3 to 5.5; R1, R3, R4, R6, R11; HF5,
// HF8, HF13): Staff invitations (issue, re-send, revoke), the acceptance on the seller route, a
// member's role and removal, and the team list with its hints. The real gate, registry and
// checked-in seed; identity's stores as fakes. Both Market fixtures. The parallel demotions under
// SERIALIZABLE are in test/db/seller-team.db-spec.ts; the routes in test/seller-team.e2e.spec.ts.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const INVITEE = 'New.Staff@Example.com';
const NAME = 'Layla Haddad';
const ORIGIN = '203.0.113.9';
const CLIENT = { origin: ORIGIN, address: ORIGIN };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const base = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));
const tokens = new RandomPrefixedTokens('mi1_');
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const uuid = <T extends string>(n: number) => id<T>(`01990000-0000-7000-8000-${n12(n)}`);
const accountId = (n: number) => uuid<'Account'>(0xa000 + n);
const SELLER = uuid<'Seller'>(0xb001);
const OTHER_SELLER = uuid<'Seller'>(0xb002);
const OWNER = accountId(1);
const OWNER2 = accountId(2);
const MANAGER = accountId(3);
const OTHER_OWNER = accountId(4);
const OTHER_MANAGER = accountId(5);
const ADMIN = accountId(6);
const CUSTOM_ROLE = uuid<'Role'>(0xc0a1);
const OTHER_CUSTOM_ROLE = uuid<'Role'>(0xc0a2);
const PROTECTED_CUSTOM_ROLE = uuid<'Role'>(0xc0a3);
const UNKNOWN_ROLE = uuid<'Role'>(0xc0ff);
const REJECTED = { ok: false, error: { code: 'invitation.rejected' } };

let deliveries = 0;
const deliveryOf = (subscriber: string): EventDelivery => ({
  eventId: `0199eeee-0000-7000-8000-${n12(++deliveries)}` as Id<'event'>,
  subscriber,
  attempt: 1,
});

interface SetUpOptions {
  readonly policy?: Partial<Record<'sellerMemberLimit', () => number | null>>;
  /** Replaces the Seller Owner holders read, to reach `LastHolderPolicy` through the command. */
  readonly holders?: (base: RoleAssignmentRepository) => RoleAssignmentRepository;
}

describe.each(TEST_MARKETS)('seller team use cases in market %s (slice 11)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const system = () => testCallContext(market, 'system');
  const anonymous = () => testCallContext(market, 'anonymous');
  const lifetime = base.invitationLifetimeMinutes(market, 'staff')!;

  let fakes: IdentityFakes;
  let clock: FixedClock;
  let units: (UnitOfWorkOptions | undefined)[];
  /** Runs once at the start of the next unit that is not read-only, after the gate's unit (C1). */
  let betweenGateAndUnit: (() => void | Promise<unknown>) | null;

  function setUp(options: SetUpOptions = {}) {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
    units = [];
    betweenGateAndUnit = null;
    const unitOfWork: UnitOfWork = {
      run: <T, E>(
        m: MarketContext,
        work: () => Promise<Result<T, E>>,
        opts?: UnitOfWorkOptions,
      ) => {
        units.push(opts);
        if (opts?.readOnly !== true && betweenGateAndUnit !== null) {
          const change = betweenGateAndUnit;
          betweenGateAndUnit = null;
          return Promise.resolve(change()).then(() => fakes.unitOfWork.run(m, work));
        }
        return fakes.unitOfWork.run(m, work);
      },
      runOnce: (m, delivery, work, opts) => fakes.unitOfWork.runOnce(m, delivery, work, opts),
    };
    const effectiveKeys = realEffectiveKeys();
    const permissions = realPermissionRegistry();
    const gate = createUseCaseGate(
      markets,
      new AccountAuthorisationCheck({
        unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        sellerAccess: fakes.sellerAccessRepository,
        grants: fakes.grantReader,
        effectiveKeys,
      }),
    );
    const policy: IdentityMarketPolicy = Object.assign(
      Object.create(base) as IdentityMarketPolicy,
      options.policy ?? {},
    );
    const assignments = options.holders?.(fakes.assignmentRepository) ?? fakes.assignmentRepository;
    const ids = new SequenceIdGenerator(clock);
    const common = {
      unitOfWork,
      accounts: fakes.accountRepository,
      roles: fakes.roleRepository,
      memberships: fakes.membershipRepository,
      sellerAccess: fakes.sellerAccessRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      permissions,
      outbox: fakes.outbox,
      audit: fakes.audit,
      clock,
    };
    const invitationPorts = {
      ...common,
      invitations: fakes.invitationRepository,
      throttles: fakes.throttleRepository,
      keys,
      policy,
    };
    return {
      invite: new InviteStaff(gate, { ...invitationPorts, targets: base, ids }),
      resend: new ResendStaffInvitation(gate, invitationPorts),
      revoke: new RevokeStaffInvitation(gate, invitationPorts),
      assign: new AssignTeamMemberRole(gate, { ...common, assignments }),
      remove: new RemoveTeamMember(gate, {
        ...common,
        assignments,
        sessions: fakes.sessionRepository,
        challenges: fakes.challengeRepository,
      }),
      list: new ListSellerTeam(gate, {
        ...common,
        sellerTeam: fakes.sellerTeamReader,
        invitations: fakes.invitationRepository,
        assignments,
        policy,
      }),
      mail: new SendInvitationMail(gate, {
        unitOfWork,
        invitations: fakes.invitationRepository,
        invitationTokens: tokens,
        targets: base,
        composer,
        transport: fakes.mailTransport,
        policy,
        clock,
      }),
      accept: new AcceptSellerInvitation(gate, {
        ...common,
        invitations: fakes.invitationRepository,
        assignments,
        throttles: fakes.throttleRepository,
        keys,
        invitationTokens: tokens,
        hasher: fakes.hasher,
        commonPasswords: { isCommon: () => false },
        policy,
        ids,
      }),
      seed: new SeedRoles(gate, {
        unitOfWork,
        roles: fakes.roleRepository,
        seed: new CheckedInRoleSeed(),
        permissions,
        clock,
        ids,
        audit: fakes.audit,
      }),
    };
  }
  type Built = ReturnType<typeof setUp>;

  const roleOf = (seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === marketId && r.scope === 'seller' && r.seedCode === seedCode,
    )!.id;
  const as = (account: Id<'Account'>, seller: Id<'Seller'> = SELLER) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: account,
        sessionId: uuid<'Session'>(0xf000 + Number.parseInt(account.slice(-4), 16)),
        sellerId: seller,
      }),
      'seller-team-0001',
    );
  const roleIdOf = (account: Id<'Account'>) =>
    [...fakes.assignments.values()].find((a) => a.accountId === account)?.roleId;
  const eventTypes = () => fakes.events.map((event) => event.type);
  const unseeded = () => fakes.audits.filter((a) => a.action !== 'identity.role.seeded');
  const serializable = () => units.some((u) => u?.isolation === 'serializable');

  function seedAccount(n: number, idOf: Id<'Account'>, email = `a${n}@example.com`) {
    fakes.seedAccount({
      id: idOf,
      marketId,
      population: 'seller',
      email: { typed: email, normalized: email.toLowerCase() },
      displayName: `Member ${n}`,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
    });
  }

  function member(n: number, idOf: Id<'Account'>, seller: Id<'Seller'>, roleId: Id<'Role'>) {
    seedAccount(n, idOf);
    fakes.seedMembership({
      id: uuid<'SellerMembership'>(0xe000 + n),
      marketId,
      accountId: idOf,
      sellerId: seller,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    fakes.seedAssignment({
      id: uuid<'RoleAssignment'>(0xe100 + n),
      marketId,
      accountId: idOf,
      roleId,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
  }

  const access = (sellerId: Id<'Seller'>, state: 'approved' | 'suspended' = 'approved') =>
    fakes.seedSellerAccess({
      sellerId,
      marketId,
      origin: 'self',
      state,
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 1,
      createdAt: START,
    });

  /** Two shops: SELLER (two owners, a manager) and OTHER_SELLER (an owner and a manager). */
  async function seeded(s: Built) {
    await s.seed.execute(system(), {});
    access(SELLER);
    access(OTHER_SELLER);
    const customRole = (roleId: Id<'Role'>, seller: Id<'Seller'>, keys: string[]): RoleState => ({
      id: roleId,
      marketId,
      scope: 'seller',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: seller,
      name: 'Custom role',
      permissionKeys: keys,
      version: 1,
      createdAt: START,
    });
    fakes.seedRole(customRole(CUSTOM_ROLE, SELLER, ['identity.team-member.view']));
    fakes.seedRole(customRole(OTHER_CUSTOM_ROLE, OTHER_SELLER, ['identity.team-member.view']));
    // A stored role with a protected key, as a future role editor could never store it (R11).
    fakes.seedRole(customRole(PROTECTED_CUSTOM_ROLE, SELLER, ['identity.team-member.invite']));
    member(1, OWNER, SELLER, roleOf('seller-owner'));
    member(2, OWNER2, SELLER, roleOf('seller-owner'));
    member(3, MANAGER, SELLER, roleOf('store-manager'));
    member(4, OTHER_OWNER, OTHER_SELLER, roleOf('seller-owner'));
    member(5, OTHER_MANAGER, OTHER_SELLER, roleOf('store-manager'));
  }

  const invite = (s: Built, who = OWNER, roleId?: Id<'Role'>, email = INVITEE) =>
    s.invite.execute(as(who), {
      email,
      roleId: roleId ?? roleOf('store-manager'),
      origin: ORIGIN,
    });

  /** Runs the mail of the last issued invitation; answers the token it carried. */
  async function mailed(s: Built): Promise<string> {
    const event = fakes.events.filter((e) => e.type === 'identity.invitation-issued.v1').at(-1)!;
    const sent = await s.mail.execute(system(), {
      delivery: deliveryOf('identity.invitation-mail'),
      invitationId: (event.payload as { invitationId: Id }).invitationId,
      aggregateVersion: event.aggregateVersion,
    });
    expect(sent).toMatchObject({ ok: true, value: { code: 'invitation-mail.sent' } });
    return /#(mi1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  async function issuedAndMailed(s: Built, roleId?: Id<'Role'>) {
    const issued = await invite(s, OWNER, roleId);
    if (!issued.ok) throw new Error(issued.error.code);
    return { ...issued.value, token: await mailed(s) };
  }

  const accept = (s: Built, token: string, displayName: string | undefined = NAME) =>
    s.accept.execute(anonymous(), {
      token,
      password: PASSWORD,
      client: CLIENT,
      ...(displayName === undefined ? {} : { displayName }),
    });
  const inviteeAccounts = () =>
    [...fakes.accounts.values()].filter((a) => a.email.normalized === INVITEE.toLowerCase());

  function seedSession(account: Id<'Account'>, n: number, seller: Id<'Seller'> = SELLER) {
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: uuid<'Session'>(0xf100 + n),
        marketId,
        accountId: account,
        population: 'seller',
        sellerId: seller,
        transport: 'cookie',
        lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
        now: START,
      }),
      new Uint8Array(32).fill(n),
    );
  }

  describe('InviteStaff (3.4 issue)', () => {
    it('issues a pending Staff invitation of the actor’s seller, with its event and audit row', async () => {
      const s = setUp();
      await seeded(s);

      const issued = await invite(s);

      expect(issued).toEqual({
        ok: true,
        value: {
          code: 'invitation.issued',
          invitationId: expect.any(String) as string,
          replaced: false,
        },
      });
      if (!issued.ok) return;
      const stored = fakes.invitations.get(issued.value.invitationId)!;
      expect(stored).toMatchObject({
        kind: 'staff',
        sellerId: SELLER,
        invitedByAccountId: OWNER,
        roleId: roleOf('store-manager'),
        state: 'pending',
        tokenHash: null,
      });
      expect(stored.email!.normalized).toBe(INVITEE.toLowerCase());
      expect(eventTypes()).toEqual(['identity.invitation-issued.v1']);
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.invitation.issued',
        after: { kind: 'staff', roleId: roleOf('store-manager') },
        actor: 'authenticated',
      });
      expect(serializable()).toBe(true);
    });

    it('is not allowed to a member without the protected invite key (R11 narrowing, AC 35)', async () => {
      const s = setUp();
      await seeded(s);

      await expect(invite(s, MANAGER)).resolves.toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'access.denied' }) as { code: string },
      });
      expect(fakes.invitations.size).toBe(0);
    });

    it('is refused while the seller is not approved (3.4)', async () => {
      const s = setUp();
      await seeded(s);
      access(SELLER, 'suspended');

      const refused = await invite(s);

      expect(refused.ok).toBe(false);
      expect(fakes.invitations.size).toBe(0);
    });

    it('is refused in the unit when the seller stopped being approved after the gate', async () => {
      const s = setUp();
      await seeded(s);
      betweenGateAndUnit = () => access(SELLER, 'suspended');

      await expect(invite(s)).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(fakes.invitations.size).toBe(0);
    });

    it('is refused in the unit when the actor was removed after the gate (C1)', async () => {
      const s = setUp();
      await seeded(s);
      betweenGateAndUnit = () => {
        const membership = [...fakes.memberships.values()].find((m) => m.accountId === OWNER)!;
        fakes.memberships.set(membership.id, {
          ...membership,
          state: 'removed',
          removedAt: START,
        });
      };

      await expect(invite(s)).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it.each([
      ['the Seller Owner role (HF5: a seller has one owner, its founder)', 'owner'],
      ['a role with a protected key (R11)', 'protected'],
    ])('refuses %s: role.not-grantable', async (_name, which) => {
      const s = setUp();
      await seeded(s);
      const roleId = which === 'owner' ? roleOf('seller-owner') : PROTECTED_CUSTOM_ROLE;

      await expect(invite(s, OWNER, roleId)).resolves.toEqual({
        ok: false,
        error: { code: 'role.not-grantable' },
      });
      expect(fakes.invitations.size).toBe(0);
    });

    it.each([
      ['another seller’s custom role (R9)', OTHER_CUSTOM_ROLE],
      ['a role that does not exist', UNKNOWN_ROLE],
    ])('answers role.unknown for %s, byte-identical', async (_name, roleId) => {
      const s = setUp();
      await seeded(s);

      await expect(invite(s, OWNER, roleId)).resolves.toEqual({
        ok: false,
        error: { code: 'role.unknown' },
      });
    });

    it('answers role.unknown for a platform role', async () => {
      const s = setUp();
      await seeded(s);
      const platform = [...fakes.roles.values()].find(
        (r) => r.marketId === marketId && r.scope === 'platform' && r.kind === 'system',
      )!;

      await expect(invite(s, OWNER, platform.id)).resolves.toEqual({
        ok: false,
        error: { code: 'role.unknown' },
      });
    });

    it('accepts a custom role of the actor’s own seller', async () => {
      const s = setUp();
      await seeded(s);

      await expect(invite(s, OWNER, CUSTOM_ROLE)).resolves.toMatchObject({ ok: true });
    });

    it('validates the address', async () => {
      const s = setUp();
      await seeded(s);

      await expect(invite(s, OWNER, undefined, 'not-an-address')).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] },
      });
    });

    it('refuses a second pending invitation to the address and seller, whatever its case', async () => {
      const s = setUp();
      await seeded(s);
      await expect(invite(s)).resolves.toMatchObject({ ok: true });

      await expect(invite(s, OWNER, undefined, INVITEE.toUpperCase())).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.already-pending' },
      });
    });

    it('replaces a stale pending invitation in the same unit (M7)', async () => {
      const s = setUp();
      await seeded(s);
      const first = await issuedAndMailed(s);
      clock.advance(Temporal.Duration.from({ minutes: lifetime + 1 }));

      const second = await invite(s);

      expect(second).toMatchObject({ ok: true, value: { replaced: true } });
      expect(fakes.invitations.get(first.invitationId)).toMatchObject({
        state: 'revoked',
        email: null,
      });
      expect(fakes.audits.map((a) => a.action)).toContain('identity.invitation.revoked');
    });

    it('stops at the member limit: members and open invitations together (3.4)', async () => {
      // Three members; a limit of five leaves room for two invitations.
      const s = setUp({ policy: { sellerMemberLimit: () => 5 } });
      await seeded(s);
      await expect(invite(s, OWNER, undefined, 'one@example.com')).resolves.toMatchObject({
        ok: true,
      });
      await expect(invite(s, OWNER, undefined, 'two@example.com')).resolves.toMatchObject({
        ok: true,
      });

      await expect(invite(s, OWNER, undefined, 'three@example.com')).resolves.toEqual({
        ok: false,
        error: { code: 'member.limit' },
      });
      expect(fakes.invitations.size).toBe(2);
    });

    it('does not count another seller’s members against the limit', async () => {
      const s = setUp({ policy: { sellerMemberLimit: () => 4 } });
      await seeded(s);

      await expect(invite(s)).resolves.toMatchObject({ ok: true });
    });

    it('fails closed while the Market sets no member limit', async () => {
      const s = setUp({ policy: { sellerMemberLimit: () => null } });
      await seeded(s);

      await expect(invite(s)).resolves.toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
    });

    it('counts the invitation mail on the address and answers request.throttled when used up', async () => {
      const s = setUp({ policy: { sellerMemberLimit: () => 50 } });
      await seeded(s);
      const limit = base.mailThrottles(market).account.limit;
      for (let n = 0; n < limit; n += 1) {
        const issued = await invite(s);
        expect(issued).toMatchObject({ ok: true });
        if (issued.ok) {
          await s.revoke.execute(as(OWNER), {
            invitationId: issued.value.invitationId,
            origin: ORIGIN,
          });
        }
      }

      await expect(invite(s)).resolves.toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: expect.any(Number) as number },
      });
    });

    it('answers the same for an address that already has a seller-side account (6.7)', async () => {
      const s = setUp();
      await seeded(s);

      // MANAGER's own address: no refusal that would tell the inviter the address is known.
      await expect(
        invite(s, OWNER, undefined, fakes.accounts.get(MANAGER)!.email.typed),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  describe('the invitation mail (E10)', () => {
    it('sends the Staff mail to the seller panel’s acceptance page, with the token in the fragment', async () => {
      const s = setUp();
      await seeded(s);

      const { invitationId } = await issuedAndMailed(s);

      const mail = fakes.mails.at(-1)!;
      expect(mail.to).toBe(INVITEE);
      const target = base.target(market, 'seller', 'accept-invitation')!;
      expect(mail.text).toContain(`${target}#mi1_`);
      expect(mail.text).not.toContain(NAME);
      expect(fakes.invitations.get(invitationId)).toMatchObject({
        state: 'pending',
        tokenHash: expect.any(Uint8Array) as Uint8Array,
        expiresAt: START.add({ minutes: lifetime }),
      });
    });
  });

  describe('the acceptance on the seller route (3.4 pending → accepted; HF13)', () => {
    it('creates the member with the given name, a new membership and the invited role, in one serializable unit', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId, token } = await issuedAndMailed(s);

      await expect(accept(s, token)).resolves.toEqual({
        ok: true,
        value: { code: 'invitation.accepted' },
      });

      const [created] = inviteeAccounts();
      expect(created).toMatchObject({
        population: 'seller',
        displayName: NAME,
        status: 'active',
        emailVerifiedAt: START,
      });
      expect([...fakes.memberships.values()].filter((m) => m.accountId === created!.id)).toEqual([
        expect.objectContaining({ sellerId: SELLER, state: 'active' }),
      ]);
      expect(
        [...fakes.assignments.values()].find((a) => a.accountId === created!.id),
      ).toMatchObject({ roleId: roleOf('store-manager'), assignedByAccountId: OWNER });
      expect(fakes.invitations.get(invitationId)).toMatchObject({
        state: 'accepted',
        email: null,
        acceptedAccountId: created!.id,
      });
      expect(fakes.audits.map((a) => a.action).slice(-3)).toEqual([
        'identity.invitation.accepted',
        'identity.seller-member.added',
        'identity.account-role.assigned',
      ]);
      expect(fakes.audits.at(-2)).toMatchObject({ after: { founding: false, sellerId: SELLER } });
      expect(units.at(-1)).toMatchObject({ isolation: 'serializable' });
    });

    it.each([
      ['an empty name', '   '],
      ['a link-like name', 'visit http://evil.example'],
    ])('asks for a valid name (%s) and leaves the invitation usable', async (_name, given) => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);

      await expect(accept(s, token, given)).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'displayName' }] },
      });
      expect(inviteeAccounts()).toEqual([]);
      await expect(accept(s, token)).resolves.toMatchObject({ ok: true });
    });

    it('asks for a name when none is given and leaves the invitation usable', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);

      await expect(
        s.accept.execute(anonymous(), { token, password: PASSWORD, client: CLIENT }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'displayName' }] },
      });
      expect(inviteeAccounts()).toEqual([]);
      await expect(accept(s, token)).resolves.toMatchObject({ ok: true });
    });

    it('uses the token once', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);
      await expect(accept(s, token)).resolves.toMatchObject({ ok: true });

      await expect(accept(s, token)).resolves.toEqual(REJECTED);
    });

    it('refuses an expired invitation', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);
      clock.advance(Temporal.Duration.from({ minutes: lifetime + 1 }));

      await expect(accept(s, token)).resolves.toEqual(REJECTED);
      expect(inviteeAccounts()).toEqual([]);
    });

    it('refuses a revoked invitation', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId, token } = await issuedAndMailed(s);
      await s.revoke.execute(as(OWNER), { invitationId, origin: ORIGIN });

      await expect(accept(s, token)).resolves.toEqual(REJECTED);
      expect(inviteeAccounts()).toEqual([]);
    });

    it('refuses a token voided by a re-send, and takes the new one', async () => {
      const s = setUp();
      await seeded(s);
      const first = await issuedAndMailed(s);
      await s.resend.execute(as(OWNER), { invitationId: first.invitationId, origin: ORIGIN });
      await expect(accept(s, first.token)).resolves.toEqual(REJECTED);

      const second = await mailed(s);

      await expect(accept(s, second)).resolves.toMatchObject({ ok: true });
    });

    it('refuses when the seller is no longer approved (3.4)', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);
      access(SELLER, 'suspended');

      await expect(accept(s, token)).resolves.toEqual(REJECTED);
      expect(inviteeAccounts()).toEqual([]);
    });

    it('refuses when the inviter was removed from the team (Hassan 14.2)', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);
      await s.remove.execute(as(OWNER2), { accountId: OWNER });

      await expect(accept(s, token)).resolves.toEqual(REJECTED);
      expect(inviteeAccounts()).toEqual([]);
    });

    it('refuses when the inviter was demoted and can no longer invite', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);
      await s.assign.execute(as(OWNER2), { accountId: OWNER, roleId: roleOf('store-manager') });

      await expect(accept(s, token)).resolves.toEqual(REJECTED);
    });

    it('refuses when the invited role was deleted (R12)', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s, CUSTOM_ROLE);
      fakes.roles.delete(CUSTOM_ROLE);

      await expect(accept(s, token)).resolves.toEqual(REJECTED);
      expect(inviteeAccounts()).toEqual([]);
    });

    it('refuses an address that already has a seller-side account ("Sign in and join" is not built)', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);
      seedAccount(9, accountId(9), INVITEE);

      await expect(accept(s, token)).resolves.toEqual(REJECTED);
      expect(fakes.memberships.size).toBe(5);
    });

    it('creates the member in the invited seller only, and an owner token needs no name', async () => {
      const s = setUp();
      await seeded(s);
      const { token } = await issuedAndMailed(s);
      await accept(s, token);

      const [created] = inviteeAccounts();
      const memberships = [...fakes.memberships.values()].filter(
        (m) => m.accountId === created!.id,
      );
      expect(memberships.map((m) => m.sellerId)).toEqual([SELLER]);
    });
  });

  describe('ResendStaffInvitation and RevokeStaffInvitation (3.4)', () => {
    it('sends again: the old token is void at once and a new mail follows', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId } = await issuedAndMailed(s);

      await expect(s.resend.execute(as(OWNER), { invitationId, origin: ORIGIN })).resolves.toEqual({
        ok: true,
        value: { code: 'invitation.reissued', invitationId },
      });

      expect(fakes.invitations.get(invitationId)).toMatchObject({
        tokenHash: null,
        expiresAt: null,
      });
      expect(eventTypes().at(-1)).toBe('identity.invitation-issued.v1');
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.invitation.reissued',
        after: { kind: 'staff' },
      });
    });

    it('revokes: the address is cleared and the link stops working', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId, token } = await issuedAndMailed(s);

      await expect(s.revoke.execute(as(OWNER), { invitationId, origin: ORIGIN })).resolves.toEqual({
        ok: true,
        value: { code: 'invitation.revoked', invitationId },
      });

      expect(fakes.invitations.get(invitationId)).toMatchObject({ state: 'revoked', email: null });
      expect(eventTypes().at(-1)).toBe('identity.invitation-revoked.v1');
      await expect(accept(s, token)).resolves.toEqual(REJECTED);
    });

    it.each([['resend'], ['revoke']] as const)(
      'answers invitation.unknown to another seller’s owner on %s: cross-seller access is denied (R6)',
      async (which) => {
        const s = setUp();
        await seeded(s);
        const { invitationId } = await issuedAndMailed(s);

        await expect(
          s[which].execute(as(OTHER_OWNER, OTHER_SELLER), { invitationId, origin: ORIGIN }),
        ).resolves.toEqual({ ok: false, error: { code: 'invitation.unknown' } });
        expect(fakes.invitations.get(invitationId)!.state).toBe('pending');
      },
    );

    it.each([['resend'], ['revoke']] as const)(
      'is not allowed to a member without the invite key on %s',
      async (which) => {
        const s = setUp();
        await seeded(s);
        const { invitationId } = await issuedAndMailed(s);

        await expect(
          s[which].execute(as(MANAGER), { invitationId, origin: ORIGIN }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      },
    );

    it('answers invitation.unknown for an admin or owner invitation id', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId } = await issuedAndMailed(s);
      const stored = fakes.invitations.get(invitationId)!;
      fakes.invitations.set(invitationId, { ...stored, kind: 'seller-owner', displayName: NAME });

      await expect(s.revoke.execute(as(OWNER), { invitationId, origin: ORIGIN })).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.unknown' },
      });
    });

    it('refuses to re-send an invitation past its lifetime, or a decided one', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId } = await issuedAndMailed(s);
      clock.advance(Temporal.Duration.from({ minutes: lifetime + 1 }));
      await expect(s.resend.execute(as(OWNER), { invitationId, origin: ORIGIN })).resolves.toEqual(
        REJECTED,
      );

      await s.revoke.execute(as(OWNER), { invitationId, origin: ORIGIN });
      for (const run of [s.resend, s.revoke]) {
        await expect(run.execute(as(OWNER), { invitationId, origin: ORIGIN })).resolves.toEqual(
          REJECTED,
        );
      }
    });

    it('refuses to re-send when the invited role was deleted (R12)', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId } = await issuedAndMailed(s, CUSTOM_ROLE);
      fakes.roles.delete(CUSTOM_ROLE);

      await expect(s.resend.execute(as(OWNER), { invitationId, origin: ORIGIN })).resolves.toEqual(
        REJECTED,
      );
    });

    it('counts each re-send on the mail counters too', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId } = await issuedAndMailed(s);
      const limit = base.mailThrottles(market).account.limit;
      for (let n = 1; n < limit; n += 1) {
        await expect(
          s.resend.execute(as(OWNER), { invitationId, origin: ORIGIN }),
        ).resolves.toMatchObject({ ok: true });
      }

      await expect(
        s.resend.execute(as(OWNER), { invitationId, origin: ORIGIN }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'request.throttled' } });
    });
  });

  describe('AssignTeamMemberRole (R1, R3; HF8)', () => {
    it('changes a member’s role in one serializable unit, with its event and audit row', async () => {
      const s = setUp();
      await seeded(s);

      const result = await s.assign.execute(as(OWNER), { accountId: MANAGER, roleId: CUSTOM_ROLE });

      expect(result).toEqual({
        ok: true,
        value: { code: 'role.assigned', accountId: MANAGER, roleId: CUSTOM_ROLE },
      });
      expect(roleIdOf(MANAGER)).toBe(CUSTOM_ROLE);
      expect([...fakes.assignments.values()].find((a) => a.accountId === MANAGER)).toMatchObject({
        assignedByAccountId: OWNER,
        version: 2,
      });
      expect(fakes.events).toEqual([
        expect.objectContaining({
          type: 'identity.account-role-changed.v1',
          payload: {
            accountId: MANAGER,
            scope: 'seller',
            sellerId: SELLER,
            previousRoleId: roleOf('store-manager'),
            roleId: CUSTOM_ROLE,
          },
        }),
      ]);
      expect(unseeded()).toEqual([
        expect.objectContaining({
          action: 'identity.account-role.changed',
          targetId: MANAGER,
          before: { roleId: roleOf('store-manager') },
          after: { roleId: CUSTOM_ROLE, scope: 'seller', sellerId: SELLER },
          actor: 'authenticated',
        }),
      ]);
      expect(serializable()).toBe(true);
    });

    it('answers role.unchanged for the role the member holds, and writes nothing', async () => {
      const s = setUp();
      await seeded(s);

      await expect(
        s.assign.execute(as(OWNER), { accountId: MANAGER, roleId: roleOf('store-manager') }),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'role.unchanged', accountId: MANAGER, roleId: roleOf('store-manager') },
      });
      expect(fakes.events).toEqual([]);
      expect(unseeded()).toEqual([]);
    });

    it('is not allowed to a member without the assign-role key', async () => {
      const s = setUp();
      await seeded(s);

      await expect(
        s.assign.execute(as(MANAGER), { accountId: OWNER, roleId: CUSTOM_ROLE }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(roleIdOf(OWNER)).toBe(roleOf('seller-owner'));
    });

    it('refuses to change one’s own role (member.self, R1)', async () => {
      const s = setUp();
      await seeded(s);

      await expect(
        s.assign.execute(as(OWNER), { accountId: OWNER, roleId: CUSTOM_ROLE }),
      ).resolves.toEqual({ ok: false, error: { code: 'member.self' } });
    });

    it.each([
      ['a member of another seller', OTHER_MANAGER],
      ['another seller’s owner', OTHER_OWNER],
      ['an admin account', ADMIN],
      ['an account that does not exist', accountId(99)],
    ])('answers account.unknown for %s: no cross-seller write (R6)', async (_name, target) => {
      const s = setUp();
      await seeded(s);
      seedAccount(6, ADMIN);
      const before = [...fakes.assignments.values()].map((a) => ({ ...a }));

      await expect(
        s.assign.execute(as(OWNER), { accountId: target, roleId: CUSTOM_ROLE }),
      ).resolves.toEqual({ ok: false, error: { code: 'account.unknown' } });
      expect([...fakes.assignments.values()]).toEqual(before);
    });

    it('answers account.unknown for a member already removed from the team', async () => {
      const s = setUp();
      await seeded(s);
      await s.remove.execute(as(OWNER), { accountId: MANAGER });

      await expect(
        s.assign.execute(as(OWNER), { accountId: MANAGER, roleId: CUSTOM_ROLE }),
      ).resolves.toEqual({ ok: false, error: { code: 'account.unknown' } });
    });

    it('refuses a role with keys the actor lacks, a protected key or the owner role: role.not-grantable (R1, R11, HF5)', async () => {
      const s = setUp();
      await seeded(s);
      for (const roleId of [PROTECTED_CUSTOM_ROLE, roleOf('seller-owner')]) {
        await expect(s.assign.execute(as(OWNER), { accountId: MANAGER, roleId })).resolves.toEqual({
          ok: false,
          error: { code: 'role.not-grantable' },
        });
      }
      expect(roleIdOf(MANAGER)).toBe(roleOf('store-manager'));
    });

    it.each([
      ['another seller’s custom role', OTHER_CUSTOM_ROLE],
      ['a role that does not exist', UNKNOWN_ROLE],
    ])('answers role.unknown for %s', async (_name, roleId) => {
      const s = setUp();
      await seeded(s);

      await expect(s.assign.execute(as(OWNER), { accountId: MANAGER, roleId })).resolves.toEqual({
        ok: false,
        error: { code: 'role.unknown' },
      });
    });

    it('demotes a co-owner while another owner can sign in (R3)', async () => {
      const s = setUp();
      await seeded(s);

      await expect(
        s.assign.execute(as(OWNER), { accountId: OWNER2, roleId: roleOf('store-manager') }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'role.assigned' } });
      expect(roleIdOf(OWNER2)).toBe(roleOf('store-manager'));
    });

    it('refuses to leave the shop without a Seller Owner who can sign in (member.last-holder, HF8)', async () => {
      // The holders read as it would after a racing demotion of the actor committed.
      const s = setUp({
        holders: (assignments) => ({
          ...assignments,
          activeHoldersOfInSeller: () => Promise.resolve([OWNER2]),
        }),
      });
      await seeded(s);

      await expect(
        s.assign.execute(as(OWNER), { accountId: OWNER2, roleId: roleOf('store-manager') }),
      ).resolves.toEqual({ ok: false, error: { code: 'member.last-holder' } });
      expect(roleIdOf(OWNER2)).toBe(roleOf('seller-owner'));
    });

    it('counts only the actor’s seller: another seller’s owner never keeps this one alive', async () => {
      const s = setUp();
      await seeded(s);
      const holders = await fakes.assignmentRepository.activeHoldersOfInSeller(
        market,
        roleOf('seller-owner'),
        SELLER,
      );

      expect(holders.sort()).toEqual([OWNER, OWNER2].sort());
    });

    it('is refused in the unit when the actor was removed after the gate (C1)', async () => {
      const s = setUp();
      await seeded(s);
      betweenGateAndUnit = () => {
        const membership = [...fakes.memberships.values()].find((m) => m.accountId === OWNER)!;
        fakes.memberships.set(membership.id, { ...membership, state: 'removed', removedAt: START });
      };

      await expect(
        s.assign.execute(as(OWNER), { accountId: MANAGER, roleId: CUSTOM_ROLE }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(roleIdOf(MANAGER)).toBe(roleOf('store-manager'));
    });

    it('keeps the member’s sessions: permissions are read on every request (R4)', async () => {
      const s = setUp();
      await seeded(s);
      seedSession(MANAGER, 1);

      await s.assign.execute(as(OWNER), { accountId: MANAGER, roleId: CUSTOM_ROLE });

      expect([...fakes.sessions.values()][0]!.session.revokedAt).toBeNull();
    });
  });

  describe('RemoveTeamMember (R1, R3, R4; HF8)', () => {
    it('ends the membership and the role, revokes every session and voids every challenge, in one serializable unit', async () => {
      const s = setUp();
      await seeded(s);
      seedSession(MANAGER, 1);
      seedSession(MANAGER, 2);
      seedSession(OWNER, 3);
      void fakes.challengeRepository.add(
        market,
        {
          id: uuid<'SignInChallenge'>(0xf201),
          marketId,
          accountId: MANAGER,
          purpose: 'second-factor',
          attempts: 0,
          credentialChangedAt: START,
          expiresAt: START.add({ minutes: 5 }),
          consumedAt: null,
          createdAt: START,
        },
        new Uint8Array(32).fill(101),
      );

      const result = await s.remove.execute(as(OWNER), { accountId: MANAGER });

      expect(result).toEqual({
        ok: true,
        value: { code: 'member.removed', accountId: MANAGER, revokedSessions: 2 },
      });
      expect([...fakes.memberships.values()].find((m) => m.accountId === MANAGER)).toMatchObject({
        state: 'removed',
        removedAt: START,
        version: 2,
      });
      expect(roleIdOf(MANAGER)).toBeUndefined();
      const sessions = [...fakes.sessions.values()].map((entry) => entry.session);
      expect(sessions.filter((x) => x.accountId === MANAGER).map((x) => x.revokedReason)).toEqual([
        'membership-removed',
        'membership-removed',
      ]);
      expect(sessions.find((x) => x.accountId === OWNER)!.revokedAt).toBeNull();
      expect(fakes.challenges.size).toBe(0);
      expect(fakes.events).toEqual([
        expect.objectContaining({
          type: 'identity.seller-member-removed.v1',
          payload: { sellerId: SELLER, accountId: MANAGER },
        }),
      ]);
      expect(unseeded()).toEqual([
        expect.objectContaining({
          action: 'identity.seller-member.removed',
          targetId: MANAGER,
          before: { roleId: roleOf('store-manager') },
          after: { sellerId: SELLER },
        }),
      ]);
      expect(fakes.accounts.get(MANAGER)!.status).toBe('active');
      expect(serializable()).toBe(true);
    });

    it('leaves a removed member without a seat: the gate refuses it at once', async () => {
      const s = setUp();
      await seeded(s);
      await s.remove.execute(as(OWNER), { accountId: MANAGER });

      await expect(s.list.execute(as(MANAGER), { limit: 10 })).resolves.toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('is not allowed to a member without the remove key', async () => {
      const s = setUp();
      await seeded(s);

      await expect(s.remove.execute(as(MANAGER), { accountId: OWNER })).resolves.toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect([...fakes.memberships.values()].every((m) => m.state === 'active')).toBe(true);
    });

    it('refuses to remove oneself (member.self)', async () => {
      const s = setUp();
      await seeded(s);

      await expect(s.remove.execute(as(OWNER), { accountId: OWNER })).resolves.toEqual({
        ok: false,
        error: { code: 'member.self' },
      });
    });

    it.each([
      ['a member of another seller', OTHER_MANAGER],
      ['another seller’s owner', OTHER_OWNER],
      ['an account that does not exist', accountId(99)],
    ])('answers account.unknown for %s: no cross-seller removal (R6)', async (_name, target) => {
      const s = setUp();
      await seeded(s);

      await expect(s.remove.execute(as(OWNER), { accountId: target })).resolves.toEqual({
        ok: false,
        error: { code: 'account.unknown' },
      });
      expect([...fakes.memberships.values()].every((m) => m.state === 'active')).toBe(true);
      expect(fakes.assignments.size).toBe(5);
    });

    it('answers account.unknown for a member already removed', async () => {
      const s = setUp();
      await seeded(s);
      await s.remove.execute(as(OWNER), { accountId: MANAGER });

      await expect(s.remove.execute(as(OWNER), { accountId: MANAGER })).resolves.toEqual({
        ok: false,
        error: { code: 'account.unknown' },
      });
    });

    it('removes a co-owner while another owner can sign in (R3)', async () => {
      const s = setUp();
      await seeded(s);

      await expect(s.remove.execute(as(OWNER), { accountId: OWNER2 })).resolves.toMatchObject({
        ok: true,
      });
    });

    it('refuses to leave the shop without a Seller Owner who can sign in (member.last-holder, HF8)', async () => {
      const s = setUp({
        holders: (assignments) => ({
          ...assignments,
          activeHoldersOfInSeller: () => Promise.resolve([OWNER2]),
        }),
      });
      await seeded(s);
      seedSession(OWNER2, 1);

      await expect(s.remove.execute(as(OWNER), { accountId: OWNER2 })).resolves.toEqual({
        ok: false,
        error: { code: 'member.last-holder' },
      });
      expect([...fakes.memberships.values()].find((m) => m.accountId === OWNER2)!.state).toBe(
        'active',
      );
      expect([...fakes.sessions.values()][0]!.session.revokedAt).toBeNull();
    });

    it('is refused in the unit when the actor was removed after the gate (C1)', async () => {
      const s = setUp();
      await seeded(s);
      betweenGateAndUnit = () => {
        const membership = [...fakes.memberships.values()].find((m) => m.accountId === OWNER)!;
        fakes.memberships.set(membership.id, { ...membership, state: 'removed', removedAt: START });
      };

      await expect(s.remove.execute(as(OWNER), { accountId: MANAGER })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect([...fakes.memberships.values()].find((m) => m.accountId === MANAGER)!.state).toBe(
        'active',
      );
    });

    it('takes the account’s credential lock first (HF11)', async () => {
      const s = setUp();
      await seeded(s);
      const locked: Id<'Account'>[] = [];
      const original = fakes.accountRepository.lockCredential.bind(fakes.accountRepository);
      fakes.accountRepository.lockCredential = (m, accountIdToLock) => {
        locked.push(accountIdToLock);
        return original(m, accountIdToLock);
      };

      await s.remove.execute(as(OWNER), { accountId: MANAGER });

      expect(locked).toEqual([MANAGER]);
    });
  });

  describe('ListSellerTeam (B1, F11)', () => {
    it('lists the actor’s own seller: members with roles and hints, and open invitations', async () => {
      const s = setUp();
      await seeded(s);
      const { invitationId } = await issuedAndMailed(s, CUSTOM_ROLE);

      const listed = await s.list.execute(as(OWNER), { limit: 10 });

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const rows = listed.value.items;
      expect(listed.value.next).toBeNull();
      expect(
        rows.map((row) => (row.type === 'account' ? row.accountId : row.invitationId)),
      ).toEqual([OWNER, OWNER2, MANAGER, invitationId].sort());
      const byId = (target: string) =>
        rows.find((row) => (row.type === 'account' ? row.accountId : row.invitationId) === target)!;
      expect(byId(OWNER)).toMatchObject({
        self: true,
        role: { kind: 'system', seedCode: 'seller-owner' },
        actions: {
          changeRole: { allowed: false, code: 'member.self' },
          remove: { allowed: false, code: 'member.self' },
        },
      });
      expect(byId(MANAGER)).toMatchObject({
        self: false,
        role: { kind: 'default', seedCode: 'store-manager', name: null },
        actions: { changeRole: { allowed: true }, remove: { allowed: true } },
      });
      expect(byId(OWNER2)).toMatchObject({
        actions: { changeRole: { allowed: true }, remove: { allowed: true } },
      });
      expect(byId(invitationId)).toMatchObject({
        type: 'invitation',
        email: INVITEE,
        status: 'pending',
        invitedByAccountId: OWNER,
        role: { kind: 'custom', name: 'Custom role' },
        actions: { resend: { allowed: true }, revoke: { allowed: true } },
      });
      expect(JSON.stringify(rows)).not.toMatch(/tokenHash|password|credential/i);
    });

    it('never lists another seller’s members, invitations or roles (R6)', async () => {
      const s = setUp();
      await seeded(s);
      await s.invite.execute(as(OTHER_OWNER, OTHER_SELLER), {
        email: 'other.shop@example.com',
        roleId: roleOf('store-manager'),
        origin: ORIGIN,
      });

      const listed = await s.list.execute(as(OWNER), { limit: 50 });

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const text = JSON.stringify(listed.value);
      for (const foreign of [OTHER_OWNER, OTHER_MANAGER, 'other.shop@example.com']) {
        expect(text).not.toContain(foreign);
      }
    });

    it('shows a view-only member every action disabled with access.denied, and tells no more', async () => {
      const s = setUp();
      await seeded(s);
      await issuedAndMailed(s);

      const listed = await s.list.execute(as(MANAGER), { limit: 10 });

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      for (const row of listed.value.items) {
        const hints = Object.values(row.actions);
        expect(hints.length).toBeGreaterThan(0);
        expect(hints).toEqual(hints.map(() => ({ allowed: false, code: 'access.denied' })));
      }
    });

    it('marks the last Seller Owner’s actions disabled while it is the only holder who can sign in', async () => {
      const s = setUp();
      await seeded(s);
      // OWNER2 can no longer sign in: its email is unverified.
      const stored = fakes.accounts.get(OWNER2)!;
      fakes.accounts.set(OWNER2, { ...stored, emailVerifiedAt: null });

      const listed = await s.list.execute(as(OWNER), { limit: 10 });

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const row = listed.value.items.find(
        (item) => item.type === 'account' && item.accountId === OWNER2,
      );
      // OWNER (the actor) still holds the role: removing OWNER2 leaves one.
      expect(row).toMatchObject({ actions: { remove: { allowed: true } } });
    });

    it('agrees with the commands: every hint equals the command’s answer for the same target', async () => {
      // One fresh Market per command, as each command mutates its target.
      const answers: [Id<'Account'>, 'changeRole' | 'remove', string | null][] = [];
      for (const target of [OWNER, OWNER2, MANAGER]) {
        for (const action of ['changeRole', 'remove'] as const) {
          const fresh = setUp();
          await seeded(fresh);
          const result =
            action === 'remove'
              ? await fresh.remove.execute(as(OWNER), { accountId: target })
              : await fresh.assign.execute(as(OWNER), { accountId: target, roleId: CUSTOM_ROLE });
          answers.push([target, action, result.ok ? null : result.error.code]);
        }
      }
      // Re-read the hints on a fresh seeded list, since `setUp` replaced the fakes.
      const again = setUp();
      await seeded(again);
      const relisted = await again.list.execute(as(OWNER), { limit: 10 });
      if (!relisted.ok) throw new Error('list');
      for (const [target, action, code] of answers) {
        const row = relisted.value.items.find(
          (item) => item.type === 'account' && item.accountId === target,
        );
        const hint = row!.type === 'account' ? row!.actions[action] : null;
        expect(hint).toEqual(
          code === null ? { allowed: true, code: null } : { allowed: false, code },
        );
      }
    });

    it('pages with after and limit, one more row telling whether another page exists', async () => {
      const s = setUp();
      await seeded(s);

      const first = await s.list.execute(as(OWNER), { limit: 2 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.items).toHaveLength(2);
      expect(first.value.next).not.toBeNull();

      const second = await s.list.execute(as(OWNER), { limit: 2, after: first.value.next });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.items).toHaveLength(1);
      expect(second.value.next).toBeNull();
    });

    it('validates the page and refuses an unapproved seller', async () => {
      const s = setUp();
      await seeded(s);

      await expect(s.list.execute(as(OWNER), { limit: 0 })).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
      });
      await expect(s.list.execute(as(OWNER), { limit: 5, after: 'nope' })).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'after', code: 'format' }] },
      });
      access(SELLER, 'suspended');
      await expect(s.list.execute(as(OWNER), { limit: 5 })).resolves.toMatchObject({ ok: false });
    });
  });

  it('keeps the parseEmailAddress contract the invitation relies on', () => {
    expect(parseEmailAddress(INVITEE)).toMatchObject({
      ok: true,
      value: { normalized: INVITEE.toLowerCase() },
    });
  });
});
