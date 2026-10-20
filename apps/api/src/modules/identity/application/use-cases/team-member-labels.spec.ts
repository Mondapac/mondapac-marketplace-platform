import { Logger } from '@nestjs/common';
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
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import { TeamMemberLabels } from './team-member-labels.use-case';

// `teamMemberLabels` (sellers' minimum-order history, seller operations P-E): name and role of
// the current members of the actor's own team, rule `own-resources`. The real gate and checked-in
// seed; identity's stores as fakes; both Markets.

const START = Temporal.Instant.from('2026-10-18T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const SELLER = id<'Seller'>('01990000-0000-7000-8000-00000000b001');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000f001');

const OTHER_SELLER = id<'Seller'>('01990000-0000-7000-8000-00000000b002');

const OWNER = accountId(1);
const MANAGER = accountId(2);
const REMOVED = accountId(3);
const ELSEWHERE = accountId(4);
const CUSTOMER = accountId(5);
const ADMIN = accountId(6);

describe.each(TEST_MARKETS)('TeamMemberLabels in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  let fakes: IdentityFakes;
  let units: (UnitOfWorkOptions | undefined)[];
  let read: TeamMemberLabels;
  /** The use case behind a gate that admits everyone, so only its own check stands. */
  let open: TeamMemberLabels;
  let membershipReads: Id<'Account'>[];

  function setUp(state: SellerAccessStateCode = 'approved') {
    fakes = new IdentityFakes();
    units = [];
    membershipReads = [];
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
    const roles = new Map<string, RoleState>();
    new CheckedInRoleSeed().roles().forEach((seeded, n) => {
      const role: RoleState = {
        id: id<'Role'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`),
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
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state,
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 1,
      createdAt: START,
    });
    const account = (
      idOf: Id<'Account'>,
      population: AccountState['population'],
      displayName: string | null,
    ) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `${idOf}@example.com`, normalized: `${idOf}@example.com` },
        displayName,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const member = (
      n: number,
      idOf: Id<'Account'>,
      seedCode: string,
      sellerId: Id<'Seller'> = SELLER,
      membership: 'active' | 'removed' = 'active',
    ) => {
      account(idOf, 'seller', `Member ${n}`);
      fakes.seedMembership({
        id: id<'SellerMembership'>(`01990000-0000-7000-8000-${n12(0xe000 + n)}`),
        marketId,
        accountId: idOf,
        sellerId,
        state: membership,
        removedAt: membership === 'removed' ? START : null,
        version: 1,
        createdAt: START,
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roles.get(`seller:${seedCode}`)!.id,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    member(1, OWNER, 'seller-owner');
    member(2, MANAGER, 'store-manager');
    member(3, REMOVED, 'store-manager', SELLER, 'removed');
    member(4, ELSEWHERE, 'seller-owner', OTHER_SELLER);
    account(CUSTOMER, 'customer', 'A Customer');
    account(ADMIN, 'admin', 'Admin Person');

    const effectiveKeys = realEffectiveKeys();
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
    const deps = {
      unitOfWork,
      accounts: fakes.accountRepository,
      memberships: {
        ...fakes.membershipRepository,
        findActiveByAccount: (m: MarketContext, accountIdOf: Id<'Account'>) => {
          membershipReads.push(accountIdOf);
          return fakes.membershipRepository.findActiveByAccount(m, accountIdOf);
        },
      },
      roles: fakes.roleRepository,
      grants: fakes.grantReader,
      effectiveKeys,
    };
    read = new TeamMemberLabels(gate, deps);
    const admitsAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
    open = new TeamMemberLabels(createUseCaseGate(markets, admitsAll), deps);
  }

  const as = (account: Id<'Account'>, population: 'seller' | 'admin' = 'seller') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: account,
        sessionId: SESSION_ID,
        sellerId: population === 'seller' ? SELLER : null,
      }),
      'team-member-labels-0001',
    );

  beforeEach(() => setUp());

  it('answers name and role of current team members, once each, in a read-only unit', async () => {
    const answer = await read.execute(as(MANAGER), { accountIds: [OWNER, MANAGER, OWNER] });

    expect(answer).toEqual({
      ok: true,
      value: [
        {
          accountId: OWNER,
          displayName: 'Member 1',
          role: expect.objectContaining({ kind: 'system', seedCode: 'seller-owner', name: null }),
        },
        {
          accountId: MANAGER,
          displayName: 'Member 2',
          role: expect.objectContaining({ kind: 'default', seedCode: 'store-manager', name: null }),
        },
      ],
    });
    expect(units.at(-1)).toEqual({ readOnly: true });
  });

  it('never answers the sign-in address', async () => {
    const answer = await read.execute(as(OWNER), { accountIds: [OWNER, MANAGER] });

    expect(JSON.stringify(answer)).not.toContain('@example.com');
  });

  it("leaves out a removed member, another seller's member, a customer, an admin and an unknown id alike", async () => {
    const answer = await read.execute(as(OWNER), {
      accountIds: [REMOVED, ELSEWHERE, CUSTOMER, ADMIN, accountId(99)],
    });

    expect(answer).toEqual({ ok: true, value: [] });
  });

  it('refuses while the seller is not approved, reading no other account', async () => {
    setUp('suspended');
    expect(await read.execute(as(OWNER), { accountIds: [MANAGER] })).toMatchObject({ ok: false });
    expect(membershipReads).toEqual([]);
  });

  it('refuses the system and an admin, and a disabled actor again in the read', async () => {
    const system = testCallContext(market, 'system', 'team-member-labels-0002');
    expect(await read.execute(system, { accountIds: [OWNER] })).toMatchObject({ ok: false });
    expect(await open.execute(as(ADMIN, 'admin'), { accountIds: [OWNER] })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    // The Manager disabled after the gate admitted the call: refused in the read's own unit.
    fakes.seedAccount({ ...fakes.accounts.get(MANAGER)!, status: 'disabled' });
    expect(await open.execute(as(MANAGER), { accountIds: [OWNER] })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(membershipReads).toEqual([]);
  });

  it('skips malformed ids, logs only counts, and refuses more than 100 ids', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const answer = await read.execute(as(OWNER), { accountIds: ['nope', 7 as never, MANAGER] });

    expect(answer).toMatchObject({ ok: true, value: [{ accountId: MANAGER }] });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ rows: 1, malformedIds: 2 }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/nope|Member 2/u);
    log.mockRestore();

    const many = Array.from({ length: 101 }, (_, n) => accountId(100 + n));
    expect(await read.execute(as(OWNER), { accountIds: many })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'accountIds', code: 'length' }] },
    });
  });
});
