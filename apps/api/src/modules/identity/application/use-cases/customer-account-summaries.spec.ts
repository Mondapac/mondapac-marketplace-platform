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
import { CustomerAccountSummaries } from './customer-account-summaries.use-case';

// `customerAccountSummaries` (the admin order pages): who placed an order, behind
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

describe.each(TEST_MARKETS)('CustomerAccountSummaries in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const other = TEST_MARKETS.find((m) => m !== code)!;
  let fakes: IdentityFakes;
  let read: CustomerAccountSummaries;
  let units: unknown[];
  /** The use case behind a gate that admits everyone, so only its own check stands. */
  let open: CustomerAccountSummaries;
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
      'customer-summaries-0001',
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
        displayName: population === 'customer' ? null : `Account ${n}`,
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
    open = new CustomerAccountSummaries(createUseCaseGate(markets, admitsAll), {
      unitOfWork: fakes.unitOfWork,
      accounts: {
        ...fakes.accountRepository,
        customerSummaries: (m, ids) => {
          accountReads.push(...ids);
          return fakes.accountRepository.customerSummaries(m, ids);
        },
      },
      grants: fakes.grantReader,
      effectiveKeys,
    });
    read = new CustomerAccountSummaries(gate, {
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

  it('answers name and address of each customer once, in a read-only unit', async () => {
    const answer = await read.execute(asAdmin(ROOT), {
      accountIds: [CUSTOMER, UNVERIFIED, CUSTOMER],
    });

    expect(answer).toEqual({
      ok: true,
      value: [
        { accountId: CUSTOMER, displayName: null, email: 'Jane.Doe@Example.com' },
        { accountId: UNVERIFIED, displayName: null, email: 'new@example.com' },
      ],
    });
    expect(units).toEqual([{ readOnly: true }]);
  });

  it('leaves out unknown, other-Market and non-customer accounts', async () => {
    const answer = await read.execute(asAdmin(ROOT), {
      accountIds: [accountId(6), accountId(99), SELLER, FINANCE],
    });

    expect(answer).toEqual({ ok: true, value: [] });
  });

  it('answers an empty request without a read', async () => {
    expect(await read.execute(asAdmin(ROOT), { accountIds: [] })).toEqual({ ok: true, value: [] });
    expect(units).toEqual([]);
  });

  it('skips malformed ids without failing the batch, and logs only their count', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    // Not an id, a version 4 UUID and a number, next to a real customer.
    const answer = await read.execute(asAdmin(ROOT), {
      accountIds: ['nope', '1b4e28ba-2fa1-41d2-883f-0016d3cca427', 7 as never, CUSTOMER],
    });

    expect(answer).toEqual({
      ok: true,
      value: [{ accountId: CUSTOMER, displayName: null, email: 'Jane.Doe@Example.com' }],
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ rows: 1, malformedIds: 3 }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('nope');
    log.mockRestore();
  });

  it('refuses too many ids, echoing no value', async () => {
    const many = Array.from({ length: 101 }, (_, n) => accountId(100 + n));
    expect(await read.execute(asAdmin(ROOT), { accountIds: many })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'accountIds', code: 'length' }] },
    });
  });

  it('refuses an admin without the view key, a customer and the system, reading nothing', async () => {
    expect(await read.execute(asAdmin(FINANCE), { accountIds: [CUSTOMER] })).toEqual({
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
      'customer-summaries-0002',
    );
    expect(await read.execute(customer, { accountIds: [CUSTOMER] })).toMatchObject({ ok: false });
    const system = testCallContext(market, 'system', 'customer-summaries-0003');
    expect(await read.execute(system, { accountIds: [CUSTOMER] })).toMatchObject({ ok: false });
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
      'customer-summaries-0004',
    );
    const root = asAdmin(ROOT);
    const actingAs = {
      ...root,
      actor: { ...root.actor, actingAs: { accountId: SELLER, sellerId: null } },
    } as unknown as typeof root;

    for (const context of [asAdmin(FINANCE), seller, actingAs]) {
      expect(await open.execute(context, { accountIds: [CUSTOMER] })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    // The admin disabled after the gate admitted the call: refused in the read's own unit.
    const rootState = fakes.accounts.get(ROOT)!;
    fakes.seedAccount({ ...rootState, status: 'disabled' });
    expect(await open.execute(asAdmin(ROOT), { accountIds: [CUSTOMER] })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(accountReads).not.toContain(CUSTOMER);
  });
});
