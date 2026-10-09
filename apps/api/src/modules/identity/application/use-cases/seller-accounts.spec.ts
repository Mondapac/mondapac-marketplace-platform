import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import { realEffectiveKeys } from '../../../../../test/support/permission-registry';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import type { SellerAccessState } from '../../domain/seller-access';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { SellerAccessContractImplementation } from '../../presentation/seller-access.contract';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { SellerAccountReader } from '../ports/seller-account-reader';
import type { ThrottleKeys } from '../ports/session-secrets';
import { ApproveSellerAccess } from './approve-seller-access.use-case';
import type { ActionHint } from './list-admin-team.use-case';
import {
  ListSellerAccounts,
  type SellerListInvitationRow,
  type SellerListPage,
  type SellerListSellerRow,
} from './list-seller-accounts.use-case';
import { ReinstateSellerAccess } from './reinstate-seller-access.use-case';
import { RejectSellerAccess } from './reject-seller-access.use-case';
import { ResendSellerInvitation } from './resend-seller-invitation.use-case';
import { RevokeSellerInvitation } from './revoke-seller-invitation.use-case';
import { SellerAccountSummaries } from './seller-account-summaries.use-case';
import { SuspendSellerAccess } from './suspend-seller-access.use-case';

// Identity slice 9b (identity design 8.1 `sellerAccountSummaries`, 8.6 rows 2, 6 and 8; `ux.md`
// P1; Ali's ruling 2026-10-09): the admin seller list with per-row hints, and the summaries
// behind the seller-access contract. The real gate, registry and checked-in seed; identity's
// stores as fakes. Both Market fixtures. Hassan's bar: personal data only to an admin holding
// `identity.seller-access.view`; only identity's own data is read. The central test runs every
// command for every row and actor and asserts the hint is the command's answer.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const basePolicy = new MarketConfigIdentityPolicy(markets);
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
const admitsAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${String(n.toString(16)).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

// Admins.
const ROOT = id<'Account'>(0xa001);
const COMPLIANCE = id<'Account'>(0xa002);
const VIEWER = id<'Account'>(0xa003);
const NO_KEY = id<'Account'>(0xa004);
const OFF = id<'Account'>(0xa005);
const NO_KEY_ROLE = id<'Role'>(0xc0ff);
// Seller-side accounts.
const O_PENDING = id<'Account'>(0xa101);
const O_APPROVED = id<'Account'>(0xa102);
const O_REJECTED = id<'Account'>(0xa103);
const O_SUSPENDED = id<'Account'>(0xa104);
const O_UNVERIFIED = id<'Account'>(0xa105);
const STAFF = id<'Account'>(0xa106);
const O_OTHER = id<'Account'>(0xa107);
// Sellers and invitations, by id order: b010 < b020 < b030 < b035 < b040 < ...
const S_PENDING = id<'Seller'>(0xb010);
const S_APPROVED = id<'Seller'>(0xb020);
const S_REJECTED = id<'Seller'>(0xb030);
const INVITATION = id<'Invitation'>(0xb035);
const S_SUSPENDED = id<'Seller'>(0xb040);
const S_UNREGISTERED = id<'Seller'>(0xb050);
const S_INVITED = id<'Seller'>(0xb060);
const S_ORPHAN = id<'Seller'>(0xb070);
const S_OTHER = id<'Seller'>(0xb080);
const OTHER_INVITATION = id<'Invitation'>(0xb085);

const ALL_ROWS = [S_PENDING, S_APPROVED, S_REJECTED, INVITATION, S_SUSPENDED];
/** Every personal value of the fixture: none may reach a log line. */
const PERSONAL = /owner-|invitee|staff@|Owner of|Invitee Name/i;

type SellerVerb = keyof SellerListSellerRow['actions'];
type InvitationVerb = keyof SellerListInvitationRow['actions'];
const VERBS: readonly SellerVerb[] = ['approve', 'reject', 'suspend', 'reinstate'];

describe.each(TEST_MARKETS)(
  'the admin seller list and summaries in market %s (slice 9b)',
  (code) => {
    const market = testMarketContext(code, PLATFORM_TENANT_ID);
    const marketId = code as AccountState['marketId'];
    const otherCode = TEST_MARKETS.find((c) => c !== code)!;
    const otherMarketId = otherCode as AccountState['marketId'];
    const system = testCallContext(market, 'system');
    const adminOf = (accountId: Id<'Account'>) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: id<'Session'>(0xd000 + Number.parseInt(accountId.slice(-4), 16)),
          sellerId: null,
        }),
      );
    const sellerActor = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: O_APPROVED,
        sessionId: id<'Session'>(0xd999),
        sellerId: S_APPROVED,
      }),
    );
    const actingAs = (context: CallContext) =>
      ({
        ...context,
        actor: { ...context.actor, actingAs: { accountId: O_APPROVED, sellerId: S_APPROVED } },
      }) as unknown as CallContext;

    let logs: jest.SpyInstance[];
    beforeEach(() => {
      logs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
    });
    afterEach(() => logs.forEach((spy) => spy.mockRestore()));
    const logged = () => JSON.stringify(logs.flatMap((spy) => spy.mock.calls as unknown[]));
    const lineOf = (msg: string) =>
      logs
        .flatMap((spy) => (spy.mock.calls as unknown[][]).map((call) => call[0]))
        .find((line) => (line as { msg?: string }).msg === msg) as Record<string, unknown>;

    function setUp(
      options: {
        readonly openGate?: boolean;
        readonly policy?: Partial<
          Pick<IdentityMarketPolicy, 'invitationLifetimeMinutes' | 'sellerReapplyLimit'>
        >;
      } = {},
    ) {
      const fakes = new IdentityFakes();
      const clock = new FixedClock(START);
      const ids = new SequenceIdGenerator(clock);
      const units: (UnitOfWorkOptions | undefined)[] = [];
      const unitOfWork: UnitOfWork = {
        run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
          units.push(o);
          return fakes.unitOfWork.run(m, work);
        },
        runOnce: (m, delivery, work, o) => fakes.unitOfWork.runOnce(m, delivery, work, o),
      };
      const effectiveKeys = realEffectiveKeys();
      const gate = createUseCaseGate(
        markets,
        options.openGate === true
          ? admitsAll
          : new AccountAuthorisationCheck({
              unitOfWork,
              accounts: fakes.accountRepository,
              memberships: fakes.membershipRepository,
              sellerAccess: fakes.sellerAccessRepository,
              grants: fakes.grantReader,
              effectiveKeys,
            }),
      );
      const policy: IdentityMarketPolicy =
        options.policy === undefined
          ? basePolicy
          : Object.assign(Object.create(basePolicy) as IdentityMarketPolicy, options.policy);
      // Counts the reads of personal rows, so a refusal can be shown to read none.
      const reads = { count: 0 };
      const counted = <K extends keyof SellerAccountReader>(name: K) =>
        ((...args: Parameters<SellerAccountReader[K]>) => {
          reads.count += 1;
          return (fakes.sellerAccountReader[name] as (...a: unknown[]) => unknown)(...args);
        }) as SellerAccountReader[K];
      const sellerAccounts: SellerAccountReader = {
        ownedSellers: counted('ownedSellers'),
        summariesOf: counted('summariesOf'),
        sellersOfAddress: counted('sellersOfAddress'),
        openOwnerInvitations: counted('openOwnerInvitations'),
      };
      const readDeps = {
        unitOfWork,
        accounts: fakes.accountRepository,
        grants: fakes.grantReader,
        effectiveKeys,
        sellerAccounts,
      };
      const decisionDeps = {
        unitOfWork,
        sellerAccess: fakes.sellerAccessRepository,
        decisions: fakes.decisionRepository,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        grants: fakes.grantReader,
        effectiveKeys,
        sessions: fakes.sessionRepository,
        challenges: fakes.challengeRepository,
        outbox: fakes.outbox,
        audit: fakes.audit,
        clock,
        ids,
      };
      const invitationDeps = {
        unitOfWork,
        accounts: fakes.accountRepository,
        grants: fakes.grantReader,
        effectiveKeys,
        invitations: fakes.invitationRepository,
        throttles: fakes.throttleRepository,
        keys,
        outbox: fakes.outbox,
        audit: fakes.audit,
        policy,
        clock,
      };
      const summaries = new SellerAccountSummaries(gate, readDeps);
      const notUsed = <T>(): T => ({}) as T;
      const s = {
        fakes,
        clock,
        units,
        reads,
        list: new ListSellerAccounts(gate, { ...readDeps, policy, clock }),
        summaries,
        contract: new SellerAccessContractImplementation({
          sellerAccessOf: notUsed(),
          sellerAccessOfSystem: notUsed(),
          sellerAccountSummaries: summaries,
          listRegisteredSellers: notUsed(),
          notifyAccessReviewers: notUsed(),
          approveSellerAccess: notUsed(),
          rejectSellerAccess: notUsed(),
          reapplySellerAccess: notUsed(),
          listSellerAccessDecisions: notUsed(),
          findAccessDecisionsByBasis: notUsed(),
        }),
        commands: {
          approve: new ApproveSellerAccess(gate, decisionDeps),
          reject: new RejectSellerAccess(gate, decisionDeps),
          suspend: new SuspendSellerAccess(gate, decisionDeps),
          reinstate: new ReinstateSellerAccess(gate, decisionDeps),
          resend: new ResendSellerInvitation(gate, invitationDeps),
          revoke: new RevokeSellerInvitation(gate, invitationDeps),
        },
      };
      seed(s.fakes);
      return s;
    }
    type Setup = ReturnType<typeof setUp>;

    function seed(fakes: IdentityFakes) {
      const roles = new Map<string, Id<'Role'>>();
      for (const m of [marketId, otherMarketId]) {
        new CheckedInRoleSeed().roles().forEach((seeded, n) => {
          const role: RoleState = {
            id: id<'Role'>((m === marketId ? 0xc000 : 0xc800) + n),
            marketId: m,
            scope: seeded.scope,
            kind: seeded.kind,
            seedCode: seeded.seedCode,
            seedVersion: seeded.seedVersion,
            sellerId: null,
            permissionKeys: seeded.kind === 'system' ? [] : [...seeded.permissionKeys].sort(),
            version: 1,
            createdAt: START,
          };
          fakes.seedRole(role);
          roles.set(`${m}:${seeded.scope}:${seeded.seedCode}`, role.id);
        });
      }
      fakes.seedRole({
        id: NO_KEY_ROLE,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: 'Custom role',
        permissionKeys: ['identity.admin-account.view'],
        version: 1,
        createdAt: START,
      });
      let n = 0;
      const account = (
        accountId: Id<'Account'>,
        population: AccountState['population'],
        label: string,
        roleId: Id<'Role'>,
        options: {
          m?: AccountState['marketId'];
          verified?: boolean;
          status?: 'active' | 'disabled';
        } = {},
      ) => {
        n += 1;
        fakes.seedAccount({
          id: accountId,
          marketId: options.m ?? marketId,
          population,
          email: {
            typed: `${label}@Example.com`,
            normalized: `${label.toLowerCase()}@example.com`,
          },
          displayName: population === 'admin' ? `Admin ${n}` : `Owner of ${label}`,
          status: options.status ?? 'active',
          emailVerifiedAt: options.verified === false ? null : START,
          existingAccountNoticeAt: null,
          signedUpAt: START,
          createdAt: START,
          version: 1,
          credential: { passwordHash: fakeHashOf('x'), changedAt: START },
        });
        fakes.seedAssignment({
          id: id<'RoleAssignment'>(0xe000 + n),
          marketId: options.m ?? marketId,
          accountId,
          roleId,
          assignedByAccountId: null,
          assignedAt: START,
          version: 1,
        });
      };
      const role = (scope: string, seedCode: string, m: string = marketId) =>
        roles.get(`${m}:${scope}:${seedCode}`)!;
      account(ROOT, 'admin', 'root', role('platform', 'platform-administrator'));
      account(COMPLIANCE, 'admin', 'compliance', role('platform', 'onboarding-compliance'));
      account(VIEWER, 'admin', 'viewer', role('platform', 'viewer'));
      account(NO_KEY, 'admin', 'nokey', NO_KEY_ROLE);
      account(OFF, 'admin', 'off', role('platform', 'platform-administrator'), {
        status: 'disabled',
      });

      const seller = (
        sellerId: Id<'Seller'>,
        state: SellerAccessState['state'],
        options: {
          origin?: 'self' | 'invitation';
          registered?: boolean;
          reapplyCount?: number;
          m?: AccountState['marketId'];
        } = {},
      ) => {
        fakes.seedSellerAccess({
          sellerId,
          marketId: options.m ?? marketId,
          origin: options.origin ?? 'self',
          state,
          stateChangedAt: START.subtract({ hours: Number.parseInt(sellerId.slice(-3), 16) % 24 }),
          reapplyCount: options.reapplyCount ?? 0,
          registeredAt: options.registered === false ? null : START,
          version: 3,
          createdAt: START,
        });
        fakes.subjectKeys.set(sellerId, 'live');
      };
      const member = (accountId: Id<'Account'>, sellerId: Id<'Seller'>, m = marketId) => {
        n += 1;
        fakes.seedMembership({
          id: id<'SellerMembership'>(0xf000 + n),
          marketId: m,
          accountId,
          sellerId,
          state: 'active',
          removedAt: null,
          version: 1,
          createdAt: START,
        });
      };
      const owner = (
        accountId: Id<'Account'>,
        label: string,
        sellerId: Id<'Seller'>,
        options: { verified?: boolean; m?: AccountState['marketId'] } = {},
      ) => {
        account(accountId, 'seller', label, role('seller', 'seller-owner', options.m), options);
        member(accountId, sellerId, options.m);
      };
      seller(S_PENDING, 'pending');
      owner(O_PENDING, 'owner-pending', S_PENDING);
      seller(S_APPROVED, 'approved');
      owner(O_APPROVED, 'owner-approved', S_APPROVED);
      account(STAFF, 'seller', 'staff', role('seller', 'store-manager'));
      member(STAFF, S_APPROVED);
      seller(S_REJECTED, 'rejected', { reapplyCount: 3 });
      owner(O_REJECTED, 'owner-rejected', S_REJECTED);
      seller(S_SUSPENDED, 'suspended', { origin: 'invitation' });
      owner(O_SUSPENDED, 'owner-suspended', S_SUSPENDED);
      // A self sign-up whose owner has not confirmed the email: not a seller yet (8.2).
      seller(S_UNREGISTERED, 'pending', { registered: false });
      owner(O_UNVERIFIED, 'owner-unverified', S_UNREGISTERED, { verified: false });
      // Created by an admin, its owner invitation open: listed as the invitation only.
      seller(S_INVITED, 'pending', { origin: 'invitation' });
      // Created by an admin, its invitation revoked: no owner, no open invitation (8.6 row 8).
      seller(S_ORPHAN, 'pending', { origin: 'invitation' });
      // Another Market's seller and invitation: never in this Market's answers.
      seller(S_OTHER, 'approved', { m: otherMarketId });
      owner(O_OTHER, 'owner-other', S_OTHER, { m: otherMarketId });
      for (const [invitationId, sellerId, m] of [
        [INVITATION, S_INVITED, marketId],
        [OTHER_INVITATION, S_OTHER, otherMarketId],
      ] as const) {
        fakes.invitations.set(invitationId, {
          id: invitationId,
          marketId: m,
          kind: 'seller-owner',
          email: { typed: 'Invitee@Example.com', normalized: 'invitee@example.com' },
          displayName: 'Invitee Name',
          roleId: role('seller', 'seller-owner', m),
          sellerId,
          invitedByAccountId: COMPLIANCE,
          tokenHash: new Uint8Array(32).fill(7),
          expiresAt: START.add({ hours: 1 }),
          state: 'pending',
          decidedAt: null,
          acceptedAccountId: null,
          createdAt: START,
          version: 2,
        });
      }
      fakes.events.length = 0;
      fakes.audits.length = 0;
    }

    const listed = async (
      s: Setup,
      context: CallContext,
      input: Partial<Parameters<Setup['list']['execute']>[1]> = {},
    ): Promise<SellerListPage> => {
      const result = await s.list.execute(context, { limit: 50, ...input });
      if (!result.ok) throw new Error(`list refused: ${result.error.code}`);
      return result.value;
    };
    const idsOf = (page: SellerListPage) =>
      page.items.map((row) => (row.type === 'seller' ? row.sellerId : row.invitationId));

    it('lists the sellers whose owner confirmed the email and the open invitations, by id', async () => {
      const s = setUp();

      const page = await listed(s, adminOf(ROOT));

      expect(idsOf(page)).toEqual(ALL_ROWS);
      expect(page.next).toBeNull();
      expect(page.items[1]).toEqual<SellerListSellerRow>({
        type: 'seller',
        sellerId: S_APPROVED,
        state: 'approved',
        stateChangedAt: s.fakes.sellerAccess.get(S_APPROVED)!.stateChangedAt,
        reapplyLimitReached: false,
        owner: {
          accountId: O_APPROVED,
          email: 'owner-approved@Example.com',
          displayName: 'Owner of owner-approved',
        },
        actions: {
          approve: { allowed: false, code: 'seller-access.wrong-state' },
          reject: { allowed: false, code: 'seller-access.wrong-state' },
          suspend: { allowed: true, code: null },
          reinstate: { allowed: false, code: 'seller-access.wrong-state' },
        },
      });
      expect(page.items[3]).toEqual<SellerListInvitationRow>({
        type: 'invitation',
        invitationId: INVITATION,
        sellerId: S_INVITED,
        email: 'Invitee@Example.com',
        displayName: 'Invitee Name',
        status: 'pending',
        createdAt: START,
        expiresAt: START.add({ hours: 1 }),
        actions: { resend: { allowed: true, code: null }, revoke: { allowed: true, code: null } },
      });
      // Never a reason, a token, a hash or a credential; only identity's own data.
      expect(JSON.stringify(page)).not.toMatch(/reason|token|hash|credential|argon/i);
      // One read-only unit, no transaction (ADR-0025), as the gate's.
      expect(s.units.every((unit) => unit?.readOnly === true)).toBe(true);
      // Codes and counts in the log line: no address, no name.
      expect(lineOf('identity.list-seller-accounts')).toEqual({
        msg: 'identity.list-seller-accounts',
        outcome: 'seller-accounts.listed',
        filter: 'all',
        search: false,
        sellers: 4,
        invitations: 1,
        more: false,
        accountId: ROOT,
        marketId: code,
        correlationId: adminOf(ROOT).correlationId,
      });
      expect(logged()).not.toMatch(PERSONAL);
    });

    it("never lists another Market's sellers or invitations, unregistered sign-ups or owner-less sellers", async () => {
      const s = setUp();

      const all = idsOf(await listed(s, adminOf(ROOT)));

      for (const absent of [S_OTHER, OTHER_INVITATION, S_UNREGISTERED, S_INVITED, S_ORPHAN]) {
        expect(all).not.toContain(absent);
      }
      // The other Market's admin context sees only its own seller and invitation.
      const other = testMarketContext(otherCode, PLATFORM_TENANT_ID);
      const result = await s.list.execute(
        testCallContext(
          other,
          testAuthenticatedActor(other, {
            population: 'admin',
            accountId: ROOT,
            sessionId: id<'Session'>(0xd001),
            sellerId: null,
          }),
        ),
        { limit: 50 },
      );
      // ROOT is not an account of the other Market: refused before any row is read.
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('answers per action the hint its command would answer, for every row and actor', async () => {
      for (const actor of [ROOT, COMPLIANCE, VIEWER]) {
        const page = await listed(setUp(), adminOf(actor));
        for (const row of page.items) {
          if (row.type === 'seller') {
            for (const verb of VERBS) {
              const fresh = setUp();
              const input = { sellerId: row.sellerId, reason: 'Why.', basisId: null };
              const answer = await fresh.commands[verb].execute(adminOf(actor), input);
              expect([actor, row.sellerId, verb, row.actions[verb]]).toEqual([
                actor,
                row.sellerId,
                verb,
                hintOf(answer),
              ]);
            }
          } else {
            for (const verb of ['resend', 'revoke'] as const satisfies readonly InvitationVerb[]) {
              const fresh = setUp();
              const answer = await fresh.commands[verb].execute(adminOf(actor), {
                invitationId: row.invitationId,
                origin: '203.0.113.9',
              });
              expect([actor, verb, row.actions[verb]]).toEqual([actor, verb, hintOf(answer)]);
            }
          }
        }
      }
    });

    it('reads whether an inviter still stands once per inviter and page, not per row (Mojtaba R2)', async () => {
      const s = setUp();
      const extra = [0xb036, 0xb037, 0xb038].map((n) => id<'Invitation'>(n));
      extra.forEach((invitationId, n) => {
        s.fakes.invitations.set(invitationId, {
          ...s.fakes.invitations.get(INVITATION)!,
          id: invitationId,
          sellerId: id<'Seller'>(0xb061 + n),
          email: { typed: `Invitee${n}@Example.com`, normalized: `invitee${n}@example.com` },
        });
      });
      const reads = jest.spyOn(s.fakes.accountRepository, 'findById');

      const page = await listed(s, adminOf(ROOT), { state: 'invited' });

      expect(idsOf(page)).toEqual([INVITATION, ...extra]);
      // Four invitations from one inviter: one inviter check (one account read of the inviter).
      expect(reads.mock.calls.filter(([, accountId]) => accountId === COMPLIANCE)).toHaveLength(1);
      // The memoized answer is the command's own: every re-send hint equals the command.
      for (const row of page.items as SellerListInvitationRow[]) {
        const answer = await setUpWith(row.invitationId);
        expect(row.actions.resend).toEqual(answer);
      }

      async function setUpWith(invitationId: Id<'Invitation'>): Promise<ActionHint> {
        const fresh = setUp();
        for (const each of extra) fresh.fakes.invitations.set(each, s.fakes.invitations.get(each)!);
        return hintOf(
          await fresh.commands.resend.execute(adminOf(ROOT), { invitationId, origin: 'o' }),
        );
      }
    });

    it('hints access.denied for every action whose key the actor lacks (viewer)', async () => {
      const page = await listed(setUp(), adminOf(VIEWER));

      for (const row of page.items) {
        for (const hint of Object.values(row.actions)) {
          expect(hint).toEqual({ allowed: false, code: 'access.denied' });
        }
      }
    });

    it("hints the re-send's refusals: an inviter who no longer stands, a lifetime passed, no lifetime", async () => {
      let s = setUp();
      s.fakes.accounts.set(COMPLIANCE, {
        ...s.fakes.accounts.get(COMPLIANCE)!,
        status: 'disabled',
      });
      const invitationRow = async (setup: Setup) =>
        (await listed(setup, adminOf(ROOT), { state: 'invited' }))
          .items[0] as SellerListInvitationRow;
      let row = await invitationRow(s);
      expect(row.actions).toEqual({
        resend: { allowed: false, code: 'invitation.rejected' },
        revoke: { allowed: true, code: null },
      });
      expect(
        hintOf(
          await s.commands.resend.execute(adminOf(ROOT), { invitationId: INVITATION, origin: 'o' }),
        ),
      ).toEqual(row.actions.resend);

      s = setUp();
      s.clock.set(START.add({ hours: 24 * 30 }));
      row = await invitationRow(s);
      expect(row).toMatchObject({
        status: 'expired',
        actions: { resend: { allowed: false, code: 'invitation.rejected' } },
      });

      s = setUp({ policy: { invitationLifetimeMinutes: () => null } });
      row = await invitationRow(s);
      expect(row.actions).toEqual({
        resend: { allowed: false, code: 'access.unavailable' },
        revoke: { allowed: false, code: 'access.unavailable' },
      });
      for (const verb of ['resend', 'revoke'] as const) {
        const answer = await s.commands[verb].execute(adminOf(ROOT), {
          invitationId: INVITATION,
          origin: 'o',
        });
        expect(hintOf(answer)).toEqual(row.actions[verb]);
      }
    });

    it('says whether a rejected seller used up its re-applications; null without a configured limit', async () => {
      let page = await listed(setUp(), adminOf(ROOT), { state: 'rejected' });
      expect(page.items).toEqual([
        expect.objectContaining({ sellerId: S_REJECTED, reapplyLimitReached: true }),
      ]);

      page = await listed(setUp({ policy: { sellerReapplyLimit: () => null } }), adminOf(ROOT));
      for (const row of page.items) {
        if (row.type === 'seller') expect(row.reapplyLimitReached).toBeNull();
      }
    });

    it.each([
      ['pending', [S_PENDING]],
      ['approved', [S_APPROVED]],
      ['rejected', [S_REJECTED]],
      ['suspended', [S_SUSPENDED]],
      ['invited', [INVITATION]],
    ] as const)('filters by state %s', async (state, expected) => {
      const s = setUp();

      expect(idsOf(await listed(s, adminOf(ROOT), { state }))).toEqual(expected);
      expect(lineOf('identity.list-seller-accounts')).toMatchObject({ filter: state });
    });

    it('refuses an unknown state, naming the field only', async () => {
      const result = await setUp().list.execute(adminOf(ROOT), { limit: 50, state: 'frozen' });

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'state', code: 'unknown' }] },
      });
    });

    it('finds by exact email only: the owner or the invitee, trimmed and in any case; never a staff address', async () => {
      const s = setUp();
      const search = async (email: string, state?: string) =>
        idsOf(await listed(s, adminOf(ROOT), { email, ...(state === undefined ? {} : { state }) }));

      expect(await search('  OWNER-APPROVED@example.COM ')).toEqual([S_APPROVED]);
      expect(await search('owner-approved@example.com', 'approved')).toEqual([S_APPROVED]);
      expect(await search('owner-approved@example.com', 'pending')).toEqual([]);
      expect(await search('owner-approved@example.com', 'invited')).toEqual([]);
      expect(await search('invitee@example.com')).toEqual([INVITATION]);
      expect(await search('invitee@example.com', 'pending')).toEqual([]);
      // A staff member's address, an unconfirmed owner's, another Market's owner and an unknown
      // address: nothing.
      expect(await search('staff@example.com')).toEqual([]);
      expect(await search('owner-unverified@example.com')).toEqual([]);
      expect(await search('owner-other@example.com')).toEqual([]);
      expect(await search('nobody@example.com')).toEqual([]);
      expect(lineOf('identity.list-seller-accounts')).toMatchObject({ search: true });
      expect(logged()).not.toMatch(PERSONAL);
      expect(logged()).not.toContain('nobody');
    });

    it('refuses a part of an address: no partial search (11.2), and never echoes it', async () => {
      const s = setUp();

      for (const email of ['owner-approved', '@example.com', 'owner%', '']) {
        const result = await s.list.execute(adminOf(ROOT), { limit: 50, email });
        expect(result).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] },
        });
      }
      expect(s.reads.count).toBe(0);
      expect(logged()).not.toContain('owner-approved');
    });

    it('pages sellers and invitations together by id, each row once', async () => {
      const s = setUp();
      const seen: string[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result: SellerListPage = await listed(s, adminOf(ROOT), { limit: 2, after });
        seen.push(...idsOf(result));
        if (result.next === null) break;
        expect(result.items).toHaveLength(2);
        after = result.next;
      }
      expect(seen).toEqual(ALL_ROWS);

      const ones = await listed(s, adminOf(ROOT), { limit: 1, after: S_REJECTED });
      expect(idsOf(ones)).toEqual([INVITATION]);
      expect(ones.next).toBe(INVITATION);
      expect(await listed(s, adminOf(ROOT), { limit: 100, after: S_SUSPENDED })).toEqual({
        items: [],
        next: null,
      });
    });

    it.each([
      [{ limit: 0 }, 'limit', 'range'],
      [{ limit: 101 }, 'limit', 'range'],
      [{ limit: 1.5 }, 'limit', 'range'],
      [{ limit: 10, after: 'not-an-id' }, 'after', 'format'],
    ] as const)('refuses %j', async (input, path, fieldCode) => {
      const s = setUp();

      await expect(s.list.execute(adminOf(ROOT), input)).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code: fieldCode }] },
      });
      expect(s.reads.count).toBe(0);
    });

    it('refuses an admin without identity.seller-access.view, a seller, the system and a disabled admin', async () => {
      const s = setUp();

      for (const context of [adminOf(NO_KEY), sellerActor, system, adminOf(OFF)]) {
        await expect(s.list.execute(context, { limit: 50 })).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        await expect(s.contract.sellerAccountSummaries(context, [S_APPROVED])).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      expect(s.reads.count).toBe(0);
      expect(logged()).not.toMatch(PERSONAL);
    });

    it('refuses them again in the use case when the gate admits, before any row is read', async () => {
      const s = setUp({ openGate: true });

      for (const context of [
        adminOf(NO_KEY),
        sellerActor,
        system,
        adminOf(OFF),
        actingAs(adminOf(ROOT)),
      ]) {
        await expect(s.list.execute(context, { limit: 50 })).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        await expect(s.contract.sellerAccountSummaries(context, [S_APPROVED])).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      // A demoted admin: refused in the read's own unit.
      s.fakes.assignments.forEach((assignment, key) => {
        if (assignment.accountId === VIEWER) {
          s.fakes.assignments.set(key, { ...assignment, roleId: NO_KEY_ROLE });
        }
      });
      await expect(s.list.execute(adminOf(VIEWER), { limit: 50 })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(s.reads.count).toBe(0);
    });

    describe('sellerAccountSummaries (8.1)', () => {
      it("answers state, its instant and the owner, for this Market's registered sellers only", async () => {
        const s = setUp();

        const result = await s.contract.sellerAccountSummaries(adminOf(VIEWER), [
          S_APPROVED,
          S_APPROVED,
          S_INVITED,
          S_UNREGISTERED,
          S_OTHER,
          id<'Seller'>(0xbfff),
        ]);

        expect(result.ok).toBe(true);
        const answer = result.ok
          ? [...result.value].sort((a, b) => (a.sellerId < b.sellerId ? -1 : 1))
          : [];
        expect(answer).toEqual([
          {
            sellerId: S_APPROVED,
            state: 'approved',
            stateChangedAt: s.fakes.sellerAccess.get(S_APPROVED)!.stateChangedAt,
            owner: {
              accountId: O_APPROVED,
              displayName: 'Owner of owner-approved',
              email: 'owner-approved@Example.com',
            },
          },
          {
            sellerId: S_INVITED,
            state: 'pending',
            stateChangedAt: s.fakes.sellerAccess.get(S_INVITED)!.stateChangedAt,
            owner: null,
          },
        ]);
        expect(JSON.stringify(answer)).not.toMatch(/reason|staff/i);
        expect(s.units.every((unit) => unit?.readOnly === true)).toBe(true);
        expect(lineOf('identity.seller-account-summaries')).toEqual({
          msg: 'identity.seller-account-summaries',
          outcome: 'seller-account-summaries.read',
          rows: 2,
          accountId: VIEWER,
          marketId: code,
          correlationId: adminOf(VIEWER).correlationId,
        });
        expect(logged()).not.toMatch(PERSONAL);
      });

      it('answers an empty list without a read, and refuses more than 100 ids or a malformed one', async () => {
        const s = setUp();

        await expect(s.contract.sellerAccountSummaries(adminOf(ROOT), [])).resolves.toEqual({
          ok: true,
          value: [],
        });
        expect(s.reads.count).toBe(0);
        const many = Array.from({ length: 101 }, (_, n) => id<'Seller'>(0xb100 + n));
        await expect(s.contract.sellerAccountSummaries(adminOf(ROOT), many)).resolves.toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'length' }] },
        });
        await expect(
          s.contract.sellerAccountSummaries(adminOf(ROOT), ['canary-7e1d' as Id<'Seller'>]),
        ).resolves.toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] },
        });
        expect(s.reads.count).toBe(0);
        expect(logged()).not.toContain('7e1d');
        // The largest batch is accepted.
        await expect(
          s.contract.sellerAccountSummaries(adminOf(ROOT), many.slice(0, 100)),
        ).resolves.toEqual({ ok: true, value: [] });
      });
    });
  },
);

function hintOf(result: Result<unknown, { readonly code: string }>): ActionHint {
  return result.ok ? { allowed: true, code: null } : { allowed: false, code: result.error.code };
}
