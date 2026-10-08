import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
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
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { IdentityFacadeImplementation } from '../../presentation/identity.facade';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import { MembershipOf } from './membership-of.use-case';
import { TeamMembershipOf } from './team-membership-of.use-case';

// Identity slice 8a-1 (identity design 8.1, 5.2, 5.6; R6): `membershipOf` for another account of
// the actor's own team under `identity.team-member.view`, and the facade that sends the actor's
// own id to `identity.membership-of` and any other id to `identity.team-membership-of`. Both
// Market fixtures, on the real registry and the checked-in seed's roles.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const accountId = (n: number) =>
  id<'Account'>(`01990000-0000-7000-8000-${String(0xa000 + n).padStart(12, '0')}`);
const SELLER = id<'Seller'>('01990000-0000-7000-8000-00000000b001');
const OTHER_SELLER = id<'Seller'>('01990000-0000-7000-8000-00000000b002');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000f001');

const OWNER = accountId(1);
const MANAGER = accountId(2);
const FULFILMENT = accountId(3);
const REMOVED = accountId(4);
const OTHER_MEMBER = accountId(5);
const NO_ROLE = accountId(6);
const UNKNOWN = accountId(99);

describe.each(TEST_MARKETS)('TeamMembershipOf and the facade in market %s (slice 8a-1)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  let fakes: IdentityFakes;
  let units: (UnitOfWorkOptions | undefined)[];
  let roles: Map<string, RoleState>;

  function setUp(state: SellerAccessStateCode = 'approved') {
    fakes = new IdentityFakes();
    units = [];
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
    roles = new Map();
    new CheckedInRoleSeed().roles().forEach((seeded, n) => {
      const role: RoleState = {
        id: id<'Role'>(`01990000-0000-7000-8000-${String(0xc000 + n).padStart(12, '0')}`),
        marketId,
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
      roles.set(`${seeded.scope}:${seeded.seedCode}`, role);
    });
    for (const [sellerId, n] of [
      [SELLER, 1],
      [OTHER_SELLER, 2],
    ] as const) {
      fakes.seedSellerAccess({
        sellerId,
        marketId,
        origin: 'self',
        state: sellerId === SELLER ? state : 'approved',
        stateChangedAt: START,
        reapplyCount: 0,
        registeredAt: START,
        version: n,
        createdAt: START,
      });
    }
    const member = (
      n: number,
      account: Id<'Account'>,
      sellerId: Id<'Seller'>,
      seedCode: string | null,
      removed = false,
    ) => {
      fakes.seedAccount({
        id: account,
        marketId,
        population: 'seller',
        email: { typed: `m${n}@example.com`, normalized: `m${n}@example.com` },
        displayName: `Member ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedMembership({
        id: id<'SellerMembership'>(
          `01990000-0000-7000-8000-${String(0xe000 + n).padStart(12, '0')}`,
        ),
        marketId,
        accountId: account,
        sellerId,
        state: removed ? 'removed' : 'active',
        removedAt: removed ? START : null,
        version: 1,
        createdAt: START,
      });
      if (seedCode === null) return;
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${String(0xe100 + n).padStart(12, '0')}`),
        marketId,
        accountId: account,
        roleId: roles.get(`seller:${seedCode}`)!.id,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    member(1, OWNER, SELLER, 'seller-owner');
    member(2, MANAGER, SELLER, 'store-manager');
    member(3, FULFILMENT, SELLER, 'order-fulfilment');
    member(4, REMOVED, SELLER, 'store-manager', true);
    member(5, OTHER_MEMBER, OTHER_SELLER, 'store-manager');
    member(6, NO_ROLE, SELLER, null);

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
    const deps = {
      unitOfWork,
      memberships: fakes.membershipRepository,
      assignments: fakes.assignmentRepository,
    };
    const team = new TeamMembershipOf(gate, deps);
    const facade = new IdentityFacadeImplementation({
      describeActor: undefined as never,
      sellerAccessOf: undefined as never,
      membershipOf: new MembershipOf(gate, deps),
      teamMembershipOf: team,
    } as never);
    return { team, facade };
  }

  const as = (account: Id<'Account'>, sellerId: Id<'Seller'> = SELLER) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: account,
        sessionId: SESSION_ID,
        sellerId,
      }),
    );
  const roleOf = (seedCode: string) => roles.get(`seller:${seedCode}`)!.id;

  it("answers a team member's membership and role to the Seller Owner, in one read-only unit", async () => {
    const { team } = setUp();

    await expect(team.execute(as(OWNER), { accountId: MANAGER })).resolves.toEqual({
      ok: true,
      value: { sellerId: SELLER, roleId: roleOf('store-manager') },
    });
    await expect(team.execute(as(OWNER), { accountId: NO_ROLE })).resolves.toEqual({
      ok: true,
      value: { sellerId: SELLER, roleId: null },
    });
    // The gate's read and the use case's read: both read-only (ADR-0025).
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u?.readOnly === true)).toBe(true);
  });

  it('allows a Store Manager (team-member.view) and denies Order Fulfilment (no key)', async () => {
    const { team } = setUp();

    await expect(team.execute(as(MANAGER), { accountId: FULFILMENT })).resolves.toEqual({
      ok: true,
      value: { sellerId: SELLER, roleId: roleOf('order-fulfilment') },
    });
    await expect(team.execute(as(FULFILMENT), { accountId: MANAGER })).resolves.toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  it("answers null, never another seller's data, for anyone outside the actor's team (R6)", async () => {
    const { team } = setUp();

    for (const other of [OTHER_MEMBER, REMOVED, UNKNOWN]) {
      await expect(team.execute(as(OWNER), { accountId: other })).resolves.toEqual({
        ok: true,
        value: null,
      });
    }
  });

  it('denies a session claiming another seller: the seller comes from the actor, checked by the gate', async () => {
    const { team } = setUp();

    await expect(
      team.execute(as(OWNER, OTHER_SELLER), { accountId: OTHER_MEMBER }),
    ).resolves.toMatchObject({ ok: false });
  });

  it.each(['pending', 'rejected'] as const)(
    'answers access.seller-not-approved while the seller is %s (not on the allow-list)',
    async (state) => {
      const { team } = setUp(state);

      await expect(team.execute(as(OWNER), { accountId: MANAGER })).resolves.toMatchObject({
        ok: false,
        error: { code: 'access.seller-not-approved' },
      });
    },
  );

  it('denies a suspended seller outright (identity design 5.2)', async () => {
    const { team } = setUp('suspended');

    await expect(team.execute(as(OWNER), { accountId: MANAGER })).resolves.toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  it('denies an administrator with every platform key: team-member.view is a seller key', async () => {
    const { team } = setUp();
    const admin = accountId(30);
    fakes.seedAccount({
      id: admin,
      marketId,
      population: 'admin',
      email: { typed: 'admin@example.com', normalized: 'admin@example.com' },
      displayName: 'Admin',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>('01990000-0000-7000-8000-00000000e130'),
      marketId,
      accountId: admin,
      roleId: roles.get('platform:platform-administrator')!.id,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    const context = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: admin,
        sessionId: SESSION_ID,
        sellerId: null,
      }),
    );

    await expect(team.execute(context, { accountId: MANAGER })).resolves.toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  describe('the facade dispatch (identity design 8.1)', () => {
    it('sends the own id to membership-of: allowed without team-member.view and while pending', async () => {
      const { facade } = setUp('pending');

      await expect(facade.membershipOf(as(FULFILMENT), FULFILMENT)).resolves.toEqual({
        ok: true,
        value: { sellerId: SELLER, roleId: roleOf('order-fulfilment') },
      });
    });

    it('sends another id to team-membership-of, under its permission rule', async () => {
      const { facade } = setUp();

      await expect(facade.membershipOf(as(OWNER), MANAGER)).resolves.toEqual({
        ok: true,
        value: { sellerId: SELLER, roleId: roleOf('store-manager') },
      });
      await expect(facade.membershipOf(as(FULFILMENT), OWNER)).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      await expect(facade.membershipOf(as(OWNER), OTHER_MEMBER)).resolves.toEqual({
        ok: true,
        value: null,
      });
    });

    it('denies a visitor whichever id it names', async () => {
      const { facade } = setUp();

      await expect(
        facade.membershipOf(testCallContext(market, 'anonymous', 'team-test-0001'), OWNER),
      ).resolves.toMatchObject({
        ok: false,
      });
    });
  });
});
