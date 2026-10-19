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
import { CustomerShortNames } from './customer-short-names.use-case';

// `customerShortNames` (the seller's order notices): the short customer name behind
// `identity.customer-short-name.view`, a seller key in no default role, so only the Seller Owner
// holds it out of the box. The real gate and checked-in seed; identity's stores as fakes; both
// Markets.

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

const OWNER = accountId(1);
const MANAGER = accountId(2);
const MARYAM = accountId(3);
const NAMELESS = accountId(4);
const ABROAD = accountId(5);
const ADMIN = accountId(6);

describe.each(TEST_MARKETS)('CustomerShortNames in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const other = TEST_MARKETS.find((m) => m !== code)!;
  let fakes: IdentityFakes;
  let units: (UnitOfWorkOptions | undefined)[];
  let read: CustomerShortNames;
  /** The use case behind a gate that admits everyone, so only its own check stands. */
  let open: CustomerShortNames;
  let accountReads: Id<'Account'>[];

  function setUp(state: SellerAccessStateCode = 'approved') {
    fakes = new IdentityFakes();
    units = [];
    accountReads = [];
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
      marketCode: string = code,
    ) =>
      fakes.seedAccount({
        id: idOf,
        marketId: marketCode as AccountState['marketId'],
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
    const member = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      account(idOf, 'seller', `Member ${n}`);
      fakes.seedMembership({
        id: id<'SellerMembership'>(`01990000-0000-7000-8000-${n12(0xe000 + n)}`),
        marketId,
        accountId: idOf,
        sellerId: SELLER,
        state: 'active',
        removedAt: null,
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
    account(MARYAM, 'customer', 'Maryam Rahimi');
    account(NAMELESS, 'customer', null);
    account(ABROAD, 'customer', 'Ali Abroad', other);
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
      accounts: {
        ...fakes.accountRepository,
        customerSummaries: (m: MarketContext, ids: readonly Id<'Account'>[]) => {
          accountReads.push(...ids);
          return fakes.accountRepository.customerSummaries(m, ids);
        },
      },
      grants: fakes.grantReader,
      effectiveKeys,
    };
    read = new CustomerShortNames(gate, deps);
    const admitsAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
    open = new CustomerShortNames(createUseCaseGate(markets, admitsAll), deps);
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
      'customer-short-names-0001',
    );

  beforeEach(() => setUp());

  it('answers the short name to the Seller Owner, once per customer, in a read-only unit', async () => {
    const answer = await read.execute(as(OWNER), { accountIds: [MARYAM, MARYAM] });

    expect(answer).toEqual({ ok: true, value: [{ accountId: MARYAM, shortName: 'Maryam R.' }] });
    expect(units.at(-1)).toEqual({ readOnly: true });
  });

  it('never answers the full name or the address', async () => {
    const answer = await read.execute(as(OWNER), { accountIds: [MARYAM] });

    expect(JSON.stringify(answer)).not.toContain('Rahimi');
    expect(JSON.stringify(answer)).not.toContain('@example.com');
  });

  it('leaves out nameless, other-Market, non-customer and unknown accounts', async () => {
    const answer = await read.execute(as(OWNER), {
      accountIds: [NAMELESS, ABROAD, ADMIN, MANAGER, accountId(99)],
    });

    expect(answer).toEqual({ ok: true, value: [] });
  });

  it('refuses a Store Manager (the key is in no default role), reading no customer', async () => {
    expect(await read.execute(as(MANAGER), { accountIds: [MARYAM] })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(accountReads).toEqual([]);
  });

  it('refuses the Seller Owner while the seller is not approved', async () => {
    setUp('suspended');
    expect(await read.execute(as(OWNER), { accountIds: [MARYAM] })).toMatchObject({ ok: false });
    expect(accountReads).toEqual([]);
  });

  it('refuses the system, an admin and an acting-as session again in the read', async () => {
    const system = testCallContext(market, 'system', 'customer-short-names-0002');
    expect(await read.execute(system, { accountIds: [MARYAM] })).toMatchObject({ ok: false });
    const owner = as(OWNER);
    const actingAs = {
      ...owner,
      actor: { ...owner.actor, actingAs: { accountId: ADMIN, sellerId: SELLER } },
    } as unknown as typeof owner;
    for (const context of [as(ADMIN, 'admin'), actingAs, as(MANAGER)]) {
      expect(await open.execute(context, { accountIds: [MARYAM] })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    // The Owner disabled after the gate admitted the call: refused in the read's own unit.
    fakes.seedAccount({ ...fakes.accounts.get(OWNER)!, status: 'disabled' });
    expect(await open.execute(as(OWNER), { accountIds: [MARYAM] })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(accountReads).toEqual([]);
  });

  it('skips malformed ids, logs only counts, and refuses more than 100 ids', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const answer = await read.execute(as(OWNER), { accountIds: ['nope', 7 as never, MARYAM] });

    expect(answer).toEqual({ ok: true, value: [{ accountId: MARYAM, shortName: 'Maryam R.' }] });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ rows: 1, malformedIds: 2 }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/nope|Maryam/u);
    log.mockRestore();

    const many = Array.from({ length: 101 }, (_, n) => accountId(100 + n));
    expect(await read.execute(as(OWNER), { accountIds: many })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'accountIds', code: 'length' }] },
    });
  });
});
