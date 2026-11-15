import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
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
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import { SearchCustomerAccounts } from './search-customer-accounts.use-case';

// `searchCustomerAccounts` (the admin order list's customer-name search), behind
// `identity.customer-account.view`. The real gate and checked-in seed; identity's stores as
// fakes; both Markets.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000f001');
const ROOT = accountId(1);
const FINANCE = accountId(2);
const CUSTOMER = accountId(3);
const UNVERIFIED = accountId(4);
const SELLER = accountId(5);

describe.each(TEST_MARKETS)('SearchCustomerAccounts in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const other = TEST_MARKETS.find((m) => m !== code)!;
  let fakes: IdentityFakes;
  let read: SearchCustomerAccounts;
  let units: unknown[];
  /** The use case behind a gate that admits everyone, so only its own check stands. */
  let open: SearchCustomerAccounts;
  /** Every account id read through the repository. */
  let accountReads: Id<'Account'>[];

  const asAdmin = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account,
        sessionId: SESSION_ID,
        sellerId: null,
      }),
      'customer-search-0001',
    );

  beforeEach(() => {
    fakes = new IdentityFakes();
    units = [];
    const roles = new Map<string, RoleState>();
    new CheckedInRoleSeed().roles().forEach((seeded, n) => {
      const role: RoleState = {
        id: id<'Role'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`),
        marketId: code as AccountState['marketId'],
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
    const account = (
      n: number,
      idOf: Id<'Account'>,
      population: AccountState['population'],
      email: { typed: string; normalized: string },
      overrides: Partial<AccountState> = {},
      marketCode: string = code,
    ) =>
      fakes.seedAccount({
        id: idOf,
        marketId: marketCode as AccountState['marketId'],
        population,
        email,
        displayName: population === 'customer' ? `Customer ${n} Citizen` : `Account ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
        ...overrides,
      });
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      account(n, idOf, 'admin', { typed: `a${n}@x.test`, normalized: `a${n}@x.test` });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: idOf,
        roleId: roles.get(`platform:${seedCode}`)!.id,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    admin(2, FINANCE, 'finance');
    account(3, CUSTOMER, 'customer', {
      typed: 'Jane.Doe@Example.com',
      normalized: 'jane.doe@example.com',
    });
    account(
      4,
      UNVERIFIED,
      'customer',
      { typed: 'new@example.com', normalized: 'new@example.com' },
      { emailVerifiedAt: null, status: 'disabled' },
    );
    account(5, SELLER, 'seller', { typed: 'shop@example.com', normalized: 'shop@example.com' });
    // The same address in another Market, and one only that Market holds.
    account(
      6,
      accountId(6),
      'customer',
      { typed: 'Jane.Doe@Example.com', normalized: 'jane.doe@example.com' },
      {},
      other,
    );
    account(
      7,
      accountId(7),
      'customer',
      { typed: 'abroad@example.com', normalized: 'abroad@example.com' },
      {},
      other,
    );
    const effectiveKeys = realEffectiveKeys();
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
    accountReads = [];
    const admitsAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
    open = new SearchCustomerAccounts(createUseCaseGate(markets, admitsAll), {
      unitOfWork: fakes.unitOfWork,
      accounts: {
        ...fakes.accountRepository,
        searchCustomerIdsByName: (m, term, limit) => {
          accountReads.push(CUSTOMER);
          return fakes.accountRepository.searchCustomerIdsByName(m, term, limit);
        },
      },
      grants: fakes.grantReader,
      effectiveKeys,
    });
    read = new SearchCustomerAccounts(gate, {
      unitOfWork: {
        ...fakes.unitOfWork,
        run: (m, work, options) => {
          units.push(options);
          return fakes.unitOfWork.run(m, work);
        },
      },
      accounts: fakes.accountRepository,
      grants: fakes.grantReader,
      effectiveKeys,
    });
  });

  it('finds customers of this Market whose name contains the text, in a read-only unit', async () => {
    const answer = await read.execute(asAdmin(ROOT), { term: '  CITIZEN ' });

    // The customers of this Market only: not the other Market's, not an admin or a seller.
    expect(answer).toEqual({
      ok: true,
      value: { accountIds: [CUSTOMER, UNVERIFIED], capped: false },
    });
    expect(await read.execute(asAdmin(ROOT), { term: 'Customer 3' })).toEqual({
      ok: true,
      value: { accountIds: [CUSTOMER], capped: false },
    });
    expect(await read.execute(asAdmin(ROOT), { term: 'Account' })).toEqual({
      ok: true,
      value: { accountIds: [], capped: false },
    });
    expect(units).toEqual([{ readOnly: true }, { readOnly: true }, { readOnly: true }]);
  });

  it('answers at most 200 accounts and flags a wider match as capped', async () => {
    for (let n = 0; n < 201; n += 1) {
      fakes.seedAccount({
        ...fakes.accounts.get(CUSTOMER)!,
        id: accountId(0x1000 + n),
        email: { typed: `wide${n}@x.test`, normalized: `wide${n}@x.test` },
        displayName: `Wide Match ${n}`,
      });
    }

    const wide = await read.execute(asAdmin(ROOT), { term: 'wide match' });
    const exact = await read.execute(asAdmin(ROOT), { term: 'Wide Match 200' });

    expect(wide.ok && wide.value.accountIds).toHaveLength(200);
    expect(wide.ok && wide.value.capped).toBe(true);
    expect(exact).toEqual({
      ok: true,
      value: { accountIds: [accountId(0x1000 + 200)], capped: false },
    });
  });

  it('refuses a term that is too short or too long, echoing nothing and reading nothing', async () => {
    const bad = {
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'term', code: 'length' }] },
    };
    expect(await read.execute(asAdmin(ROOT), { term: ' a ' })).toEqual(bad);
    expect(await read.execute(asAdmin(ROOT), { term: 'x'.repeat(81) })).toEqual(bad);
    expect(await read.execute(asAdmin(ROOT), { term: 5 as never })).toEqual(bad);
    expect(units).toEqual([]);
  });

  it('logs the counts, never the text', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    await read.execute(asAdmin(ROOT), { term: 'citizen' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ rows: 2, capped: false }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('citizen');
    log.mockRestore();
  });

  it('refuses an admin without the view key, a customer and the system, reading nothing', async () => {
    expect(await read.execute(asAdmin(FINANCE), { term: 'citizen' })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: CUSTOMER,
        sessionId: SESSION_ID,
        sellerId: null,
      }),
      'customer-search-0002',
    );
    expect(await read.execute(customer, { term: 'citizen' })).toMatchObject({ ok: false });
    const system = testCallContext(market, 'system', 'customer-search-0003');
    expect(await read.execute(system, { term: 'citizen' })).toMatchObject({ ok: false });
    expect(units).toEqual([]);
  });

  it('refuses them again in the read when the gate admits, before any customer row', async () => {
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: SELLER,
        sessionId: SESSION_ID,
        sellerId: id<'Seller'>('01990000-0000-7000-8000-00000000b001'),
      }),
      'customer-search-0004',
    );
    const root = asAdmin(ROOT);
    const actingAs = {
      ...root,
      actor: { ...root.actor, actingAs: { accountId: SELLER, sellerId: null } },
    } as unknown as typeof root;

    for (const context of [asAdmin(FINANCE), seller, actingAs]) {
      expect(await open.execute(context, { term: 'citizen' })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    const rootState = fakes.accounts.get(ROOT)!;
    fakes.seedAccount({ ...rootState, status: 'disabled' });
    expect(await open.execute(asAdmin(ROOT), { term: 'citizen' })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(accountReads).toEqual([]);
  });
});
