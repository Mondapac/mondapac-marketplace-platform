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
import type { InvitationKind, InvitationState } from '../../domain/invitation';
import { CatalogueMailComposer } from '../../infrastructure/mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { RandomPrefixedTokens } from '../../infrastructure/second-factor/second-factor-tokens';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import { AcceptSellerInvitation } from './accept-seller-invitation.use-case';
import { InviteSeller } from './invite-seller.use-case';
import { ResendSellerInvitation } from './resend-seller-invitation.use-case';
import { RevokeSellerInvitation } from './revoke-seller-invitation.use-case';
import { SeedRoles } from './seed-roles.use-case';
import { SendInvitationMail } from './send-invitation-mail.use-case';

// Identity slice 9 in memory, round 1 of PR #204: a seller created by an admin's invitation
// (identity design 3.4, 6.8; data design 3.10): one pending seller-owner invitation per address
// in the Market (Mohammad ask 1, Hassan L1), the invitation mail's counters (Hassan M1), re-send
// and revoke at their edges, and the anonymous acceptance with each of its refusals (Hassan M2,
// Sajad 3). Both Market fixtures. The parallel acceptance under SERIALIZABLE is in
// test/db/seller-invitations.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const INVITEE = 'Invited.Owner@Example.com';
const NAME = 'Amina Rahman';
const ORIGIN = '203.0.113.9';
const CLIENT = { origin: ORIGIN, address: ORIGIN };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
/** The real policy: both Market files configure the seller acceptance page. */
const policy = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));
const tokens = new RandomPrefixedTokens('mi1_');
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};

const n12 = (n: number) => String(n).padStart(12, '0');
const uuid = <T extends string>(n: number) => `01990000-0000-7000-8000-${n12(n)}` as Id<T>;
const ADMIN = uuid<'Account'>(0xa003);
const VIEWER = uuid<'Account'>(0xa004);
const OTHER_ADMIN = uuid<'Account'>(0xa005);

let deliveries = 0;
const deliveryOf = (subscriber: string): EventDelivery => ({
  eventId: `0199eeee-0000-7000-8000-${n12(++deliveries)}` as Id<'event'>,
  subscriber,
  attempt: 1,
});

function setUp(
  options: { readonly invitations?: (base: InvitationRepository) => InvitationRepository } = {},
) {
  const fakes = new IdentityFakes();
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
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
  const invitations =
    options.invitations?.(fakes.invitationRepository) ?? fakes.invitationRepository;
  const common = {
    unitOfWork,
    accounts: fakes.accountRepository,
    grants: fakes.grantReader,
    effectiveKeys: realEffectiveKeys(),
    invitations,
    throttles: fakes.throttleRepository,
    keys,
    outbox: fakes.outbox,
    audit: fakes.audit,
    policy,
    clock,
  };
  return {
    fakes,
    clock,
    units,
    invite: new InviteSeller(gate, {
      ...common,
      roles: fakes.roleRepository,
      sellerAccess: fakes.sellerAccessRepository,
      memberships: fakes.membershipRepository,
      targets: policy,
      ids,
    }),
    resend: new ResendSellerInvitation(gate, common),
    revoke: new RevokeSellerInvitation(gate, common),
    mail: new SendInvitationMail(gate, {
      unitOfWork,
      invitations: fakes.invitationRepository,
      invitationTokens: tokens,
      targets: policy,
      composer,
      transport: fakes.mailTransport,
      policy,
      clock,
    }),
    accept: new AcceptSellerInvitation(gate, {
      ...common,
      invitations: fakes.invitationRepository,
      roles: fakes.roleRepository,
      assignments: fakes.assignmentRepository,
      memberships: fakes.membershipRepository,
      sellerAccess: fakes.sellerAccessRepository,
      invitationTokens: tokens,
      hasher: fakes.hasher,
      commonPasswords: { isCommon: () => false },
      ids,
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

describe.each(TEST_MARKETS)(
  'seller invitations in market %s (slice 9, PR #204 round 1)',
  (code) => {
    const market = testMarketContext(code, PLATFORM_TENANT_ID);
    const otherCode = TEST_MARKETS.find((c) => c !== code)!;
    const other = testMarketContext(otherCode, PLATFORM_TENANT_ID);
    const marketId = code as AccountState['marketId'];
    const system = (m: MarketContext = market) => testCallContext(m, 'system');
    const anonymous = (m: MarketContext = market) => testCallContext(m, 'anonymous');
    const adminOf = (accountId: Id<'Account'>, m: MarketContext = market) =>
      testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'admin',
          accountId,
          sessionId: uuid<'Session'>(0xc000 + Number.parseInt(accountId.slice(-4), 16)),
          sellerId: null,
        }),
      );
    const admin = adminOf(ADMIN);
    const lifetime = policy.invitationLifetimeMinutes(market, 'seller-owner')!;
    const mailLimit = policy.mailThrottles(market).account.limit;

    const roleOf = (s: Setup, m: string, scope: string, seedCode: string) =>
      [...s.fakes.roles.values()].find(
        (r) => r.marketId === m && r.scope === scope && r.seedCode === seedCode,
      )!.id;

    function account(
      s: Setup,
      id: Id<'Account'>,
      population: AccountState['population'],
      email: string,
      m: AccountState['marketId'] = marketId,
    ) {
      s.fakes.seedAccount({
        id,
        marketId: m,
        population,
        email: { typed: email, normalized: email.toLowerCase() },
        displayName: 'Someone',
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
      });
    }

    /** Both Markets' roles; an onboarding admin and a viewer here, an onboarding admin there. */
    async function seeded(s: Setup) {
      await s.seed.execute(system(), {});
      await s.seed.execute(system(other), {});
      const assign = (n: number, accountId: Id<'Account'>, m: string, seedCode: string) =>
        s.fakes.seedAssignment({
          id: uuid<'RoleAssignment'>(0xe000 + n),
          marketId: m as AccountState['marketId'],
          accountId,
          roleId: roleOf(s, m, 'platform', seedCode),
          assignedByAccountId: null,
          assignedAt: START,
          version: 1,
        });
      account(s, ADMIN, 'admin', 'admin@example.com');
      account(s, VIEWER, 'admin', 'viewer@example.com');
      account(s, OTHER_ADMIN, 'admin', 'other@example.com', otherCode as AccountState['marketId']);
      assign(1, ADMIN, code, 'onboarding-compliance');
      assign(2, VIEWER, code, 'viewer');
      assign(3, OTHER_ADMIN, otherCode, 'onboarding-compliance');
    }

    const invite = (s: Setup, email = INVITEE, sellerId?: Id<'Seller'>) =>
      s.invite.execute(admin, {
        email,
        displayName: NAME,
        origin: ORIGIN,
        ...(sellerId === undefined ? {} : { sellerId }),
      });

    /** Runs the mail of the last issued invitation; answers the token it carried. */
    async function mailed(s: Setup): Promise<string> {
      const event = s.fakes.events
        .filter((e) => e.type === 'identity.invitation-issued.v1')
        .at(-1)!;
      const sent = await s.mail.execute(system(), {
        delivery: deliveryOf('identity.invitation-mail'),
        invitationId: (event.payload as { invitationId: Id }).invitationId,
        aggregateVersion: event.aggregateVersion,
      });
      expect(sent).toMatchObject({ ok: true, value: { code: 'invitation-mail.sent' } });
      return /#(mi1_[A-Za-z0-9_-]{43})/.exec(s.fakes.mails.at(-1)!.text)![1]!;
    }

    async function issuedAndMailed(s: Setup) {
      const issued = await invite(s);
      if (!issued.ok) throw new Error(issued.error.code);
      return { ...issued.value, token: await mailed(s) };
    }

    const accept = (s: Setup, token: string, password = PASSWORD, m: MarketContext = market) =>
      s.accept.execute(anonymous(m), { token, password, client: CLIENT });
    const REJECTED = { ok: false, error: { code: 'invitation.rejected' } };
    const ownerAccounts = (s: Setup) =>
      [...s.fakes.accounts.values()].filter((a) => a.email.normalized === INVITEE.toLowerCase());

    /** A dispatched invitation stored directly, with a token: other kinds and Markets. */
    function seededInvitation(
      s: Setup,
      kind: InvitationKind,
      m: string,
      overrides: Partial<InvitationState> = {},
    ): string {
      const issued = tokens.issue();
      const id = uuid<'Invitation'>(0x9000 + s.fakes.invitations.size);
      s.fakes.invitations.set(id, {
        id,
        marketId: m as AccountState['marketId'],
        kind,
        email: { typed: INVITEE, normalized: INVITEE.toLowerCase() },
        displayName: kind === 'seller-owner' ? NAME : null,
        roleId: roleOf(
          s,
          m,
          kind === 'admin' ? 'platform' : 'seller',
          kind === 'admin' ? 'viewer' : 'seller-owner',
        ),
        sellerId: kind === 'admin' ? null : uuid<'Seller'>(0xb0f0),
        invitedByAccountId: ADMIN,
        tokenHash: issued.tokenHash,
        expiresAt: START.add({ hours: 24 }),
        state: 'pending',
        decidedAt: null,
        acceptedAccountId: null,
        createdAt: START,
        version: 2,
        ...overrides,
      });
      return issued.token;
    }

    describe('one pending owner invitation per address in the Market (3.4)', () => {
      it('refuses a second invitation to the address, whatever its case, and creates no second seller', async () => {
        const s = setUp();
        await seeded(s);
        await expect(invite(s)).resolves.toMatchObject({ ok: true });

        await expect(invite(s, INVITEE.toUpperCase())).resolves.toEqual({
          ok: false,
          error: { code: 'invitation.already-pending' },
        });
        expect(s.fakes.sellerAccess.size).toBe(1);
      });

      it("replaces another seller's expired invitation to the address in the same unit (M7)", async () => {
        const s = setUp();
        await seeded(s);
        const first = await issuedAndMailed(s);
        s.clock.advance(Temporal.Duration.from({ minutes: lifetime + 1 }));

        const second = await invite(s);

        expect(second).toMatchObject({
          ok: true,
          value: { code: 'invitation.issued', replaced: true },
        });
        expect(s.fakes.invitations.get(first.invitationId)!.state).toBe('revoked');
        expect(s.fakes.sellerAccess.size).toBe(2);
        expect(s.fakes.audits.map((a) => a.action)).toContain('identity.invitation.revoked');
      });

      it('answers invitation.already-pending when the unique key refuses a concurrent issue', async () => {
        const s = setUp({
          invitations: (base) => ({
            ...base,
            // The concurrent issue committed after this unit's read.
            findPendingOwnerInvitationByEmail: () => Promise.resolve(null),
          }),
        });
        await seeded(s);
        await invite(s);

        await expect(invite(s)).resolves.toEqual({
          ok: false,
          error: { code: 'invitation.already-pending' },
        });
      });
    });

    describe('the invitation mail counters (6.8; Hassan M1)', () => {
      it('counts each invitation on the address, then answers request.throttled', async () => {
        const s = setUp();
        await seeded(s);
        for (let n = 0; n < mailLimit; n += 1) {
          const issued = await invite(s);
          expect(issued).toMatchObject({ ok: true });
          if (issued.ok) {
            await s.revoke.execute(admin, {
              invitationId: issued.value.invitationId,
              origin: ORIGIN,
            });
          }
        }

        const refused = await invite(s);

        expect(refused).toEqual({
          ok: false,
          error: { code: 'request.throttled', retryAfterSeconds: expect.any(Number) as number },
        });
      });

      it('counts each re-send on the address too', async () => {
        const s = setUp();
        await seeded(s);
        const { invitationId } = await issuedAndMailed(s);
        for (let n = 1; n < mailLimit; n += 1) {
          await expect(
            s.resend.execute(admin, { invitationId, origin: ORIGIN }),
          ).resolves.toMatchObject({ ok: true, value: { code: 'invitation.reissued' } });
        }

        await expect(
          s.resend.execute(admin, { invitationId, origin: ORIGIN }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'request.throttled' } });
      });
    });

    describe('re-send and revoke at their edges (Sajad 6)', () => {
      it('refuses both on an accepted invitation', async () => {
        const s = setUp();
        await seeded(s);
        const { invitationId, token } = await issuedAndMailed(s);
        await expect(accept(s, token)).resolves.toMatchObject({ ok: true });

        for (const run of [s.resend, s.revoke]) {
          await expect(run.execute(admin, { invitationId, origin: ORIGIN })).resolves.toEqual(
            REJECTED,
          );
        }
      });

      it('refuses to re-send an invitation past its lifetime', async () => {
        const s = setUp();
        await seeded(s);
        const { invitationId } = await issuedAndMailed(s);
        s.clock.advance(Temporal.Duration.from({ minutes: lifetime + 1 }));

        await expect(s.resend.execute(admin, { invitationId, origin: ORIGIN })).resolves.toEqual(
          REJECTED,
        );
      });

      it("answers invitation.unknown to another Market's admin", async () => {
        const s = setUp();
        await seeded(s);
        const { invitationId } = await issuedAndMailed(s);

        for (const run of [s.resend, s.revoke]) {
          await expect(
            run.execute(adminOf(OTHER_ADMIN, other), { invitationId, origin: ORIGIN }),
          ).resolves.toEqual({ ok: false, error: { code: 'invitation.unknown' } });
        }
        expect(s.fakes.invitations.get(invitationId)!.state).toBe('pending');
      });
    });

    describe('the anonymous acceptance (3.4; Hassan M2, Sajad 3)', () => {
      it('creates the owner, its membership and system role in one serializable unit', async () => {
        const s = setUp();
        await seeded(s);
        const { sellerId, token } = await issuedAndMailed(s);

        await expect(accept(s, token)).resolves.toEqual({
          ok: true,
          value: { code: 'invitation.accepted' },
        });

        const [owner] = ownerAccounts(s);
        expect(owner).toMatchObject({ population: 'seller', displayName: NAME, status: 'active' });
        expect([...s.fakes.memberships.values()]).toEqual([
          expect.objectContaining({ accountId: owner!.id, sellerId, state: 'active' }),
        ]);
        expect(s.units.at(-1)).toMatchObject({ isolation: 'serializable' });
      });

      it.each([
        ['an admin invitation', 'admin' as const],
        ['a staff invitation', 'staff' as const],
      ])('refuses the token of %s at the seller route', async (_name, kind) => {
        const s = setUp();
        await seeded(s);
        const token = seededInvitation(s, kind, code);

        await expect(accept(s, token)).resolves.toEqual(REJECTED);
        expect(ownerAccounts(s)).toEqual([]);
      });

      it("refuses another Market's token", async () => {
        const s = setUp();
        await seeded(s);
        const token = seededInvitation(s, 'seller-owner', otherCode);

        await expect(accept(s, token)).resolves.toEqual(REJECTED);
      });

      it('refuses an expired token and a garbage one', async () => {
        const s = setUp();
        await seeded(s);
        const { token } = await issuedAndMailed(s);
        s.clock.advance(Temporal.Duration.from({ minutes: lifetime + 1 }));

        await expect(accept(s, token)).resolves.toEqual(REJECTED);
        await expect(accept(s, 'not-a-token')).resolves.toEqual(REJECTED);
      });

      it.each([
        [
          'the inviter lost the key',
          (s: Setup) => {
            const assignment = [...s.fakes.assignments.values()].find(
              (a) => a.accountId === ADMIN,
            )!;
            s.fakes.assignments.set(assignment.id, {
              ...assignment,
              roleId: roleOf(s, code, 'platform', 'viewer'),
            });
          },
        ],
        [
          'the inviter was disabled',
          (s: Setup) => {
            s.fakes.accounts.set(ADMIN, { ...s.fakes.accounts.get(ADMIN)!, status: 'disabled' });
          },
        ],
        [
          'the address has a seller account by then',
          (s: Setup) => account(s, uuid<'Account'>(0xa0ff), 'seller', INVITEE),
        ],
        [
          'the seller has a member by then',
          (s: Setup) => {
            const [seller] = [...s.fakes.sellerAccess.values()];
            s.fakes.seedMembership({
              id: uuid<'SellerMembership'>(0xf0ff),
              marketId,
              accountId: VIEWER,
              sellerId: seller!.sellerId,
              state: 'removed',
              removedAt: START,
              version: 2,
              createdAt: START,
            });
          },
        ],
      ])('refuses at closing when %s', async (_name, change) => {
        const s = setUp();
        await seeded(s);
        const { token } = await issuedAndMailed(s);
        change(s);
        const before = s.fakes.accounts.size;

        await expect(accept(s, token)).resolves.toEqual(REJECTED);
        expect(s.fakes.accounts.size).toBe(before);
      });

      it('keeps the origin counted on an unknown token, and gives it back on a usable one', async () => {
        const s = setUp();
        await seeded(s);
        const { token } = await issuedAndMailed(s);
        const attempts = () =>
          [...s.fakes.throttles.values()]
            .filter((row) => row.kind === 'sign-in.origin')
            .reduce((sum, row) => sum + row.attempts, 0);

        await accept(s, `mi1_${'A'.repeat(43)}`);
        expect(attempts()).toBe(1);
        await expect(accept(s, token)).resolves.toMatchObject({ ok: true });
        expect(attempts()).toBe(1);
      });

      it('refuses a weak password before the closing unit; the token stays usable', async () => {
        const s = setUp();
        await seeded(s);
        const { token } = await issuedAndMailed(s);
        const units = s.units.length;

        await expect(accept(s, token, 'short')).resolves.toMatchObject({
          ok: false,
          error: { code: 'password.rejected' },
        });
        // Only the reservation unit ran.
        expect(s.units.length).toBe(units + 1);
        await expect(accept(s, token)).resolves.toMatchObject({ ok: true });
      });
    });
  },
);
