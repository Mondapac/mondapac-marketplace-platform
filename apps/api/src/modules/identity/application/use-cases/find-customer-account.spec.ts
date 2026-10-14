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
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import { FindCustomerAccount } from './find-customer-account.use-case';

// Identity slice 8d (identity design 12.1 `identity.customer-account.view`): customer lookup by
// exact email. The real gate and checked-in seed; identity's stores as fakes; both Markets.

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

describe.each(TEST_MARKETS)('FindCustomerAccount in market %s (slice 8d)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const other = TEST_MARKETS.find((m) => m !== code)!;
  let fakes: IdentityFakes;
  let find: FindCustomerAccount;
  let units: unknown[];

  const asAdmin = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account,
        sessionId: SESSION_ID,
        sellerId: null,
      }),
      'find-customer-0001',
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
    find = new FindCustomerAccount(gate, {
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

  it('finds a customer by exact email, in a read-only unit, with minimal fields', async () => {
    const found = await find.execute(asAdmin(ROOT), { email: 'Jane.Doe@Example.com' });

    expect(found).toEqual({
      ok: true,
      value: {
        accountId: CUSTOMER,
        email: 'Jane.Doe@Example.com',
        status: 'active',
        createdAt: START,
        emailVerified: true,
      },
    });
    expect(units).toEqual([{ readOnly: true }]);
  });

  it('normalises as at sign-in: case, whitespace and NFC do not matter', async () => {
    for (const typed of ['  JANE.DOE@example.COM ', 'jane.doe@example.com\t']) {
      const found = await find.execute(asAdmin(ROOT), { email: typed });
      expect(found).toMatchObject({ ok: true, value: { accountId: CUSTOMER } });
    }
  });

  it('shows a disabled, unverified customer as it is', async () => {
    expect(await find.execute(asAdmin(ROOT), { email: 'new@example.com' })).toMatchObject({
      ok: true,
      value: { accountId: UNVERIFIED, status: 'disabled', emailVerified: false },
    });
  });

  it('answers the same customer.not-found for unknown, other-Market and non-customer emails', async () => {
    const answers = await Promise.all(
      [
        'nobody@example.com',
        'abroad@example.com',
        'shop@example.com',
        'a1@x.test',
        'jane.doe@example.co',
      ].map((email) => find.execute(asAdmin(ROOT), { email })),
    );

    for (const answer of answers) {
      expect(answer).toEqual({ ok: false, error: { code: 'customer.not-found' } });
    }
  });

  it('matches exactly: no prefix or partial search', async () => {
    for (const email of ['jane.doe@', 'jane@example.com', 'doe@example.com']) {
      const answer = await find.execute(asAdmin(ROOT), { email });
      expect(answer.ok).toBe(false);
    }
  });

  it('refuses a malformed address as validation.failed on the email field', async () => {
    expect(await find.execute(asAdmin(ROOT), { email: 'not-an-email' })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] },
    });
  });

  it('refuses an admin without the view key and a non-admin actor, reading nothing', async () => {
    const before = units.length;
    expect(await find.execute(asAdmin(FINANCE), { email: 'jane.doe@example.com' })).toEqual({
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
      'find-customer-0002',
    );
    expect(await find.execute(customer, { email: 'jane.doe@example.com' })).toMatchObject({
      ok: false,
    });
    expect(units.length).toBe(before);
  });
});
