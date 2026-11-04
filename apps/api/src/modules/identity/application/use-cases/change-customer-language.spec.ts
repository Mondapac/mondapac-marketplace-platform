import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import type { AccessDecision, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import { ChangeCustomerLanguage } from './change-customer-language.use-case';

// A customer keeps the own language on the account (buyer profile), for both
// Market fixtures.

const START = Temporal.Instant.from('2026-10-16T10:00:00Z');
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-0000000000a1');
const SELLER_ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-0000000000b1');
const CUSTOMER_ID = id<'Account'>('01990000-0000-7000-8000-0000000000c1');
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-0000000000d1');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe.each(TEST_MARKETS)('ChangeCustomerLanguage in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;

  beforeEach(() => {
    fakes = new IdentityFakes();
  });

  function seed(
    accountId: Id<'Account'>,
    population: 'admin' | 'seller' | 'customer',
    overrides: Partial<AccountState> = {},
  ) {
    fakes.seedAccount({
      id: accountId,
      marketId: market.marketId,
      population,
      email: { typed: 'Me@Example.com', normalized: 'me@example.com' },
      displayName: population === 'customer' ? null : 'Amina Rahman',
      status: 'active',
      emailVerifiedAt: START.subtract({ hours: 48 }),
      existingAccountNoticeAt: null,
      signedUpAt: START.subtract({ hours: 49 }),
      createdAt: START.subtract({ hours: 49 }),
      version: 3,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      ...overrides,
    });
  }
  const useCase = () =>
    new ChangeCustomerLanguage(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
    });
  const contextOf = (population: 'admin' | 'seller' | 'customer', accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId: SESSION_ID,
        sellerId: population === 'seller' ? SELLER_ID : null,
      }),
    );

  it('declares own-resources, denied for a seller that is not approved', () => {
    expect(ChangeCustomerLanguage.access).toEqual({
      name: 'identity.change-customer-language',
      rule: { kind: 'own-resources' },
      whenSellerNotApproved: 'deny',
    });
  });

  it('keeps the language of the own customer account', async () => {
    seed(CUSTOMER_ID, 'customer');

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { locale: 'fa' }),
    ).resolves.toEqual({ ok: true, value: { code: 'customer-language-changed', changed: true } });

    expect(fakes.accounts.get(CUSTOMER_ID)).toMatchObject({ locale: 'fa', version: 4 });
  });

  it('changes nothing for the same value, and clears the choice with null', async () => {
    seed(CUSTOMER_ID, 'customer', { locale: 'ar' });

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { locale: 'ar' }),
    ).resolves.toEqual({ ok: true, value: { code: 'customer-language-changed', changed: false } });
    expect(fakes.accounts.get(CUSTOMER_ID)!.version).toBe(3);

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { locale: null }),
    ).resolves.toMatchObject({ ok: true, value: { changed: true } });
    expect(fakes.accounts.get(CUSTOMER_ID)!.locale ?? null).toBeNull();
  });

  it.each(['de', 'FA', 'fa-IR', '', 'en '])('refuses %j', async (locale) => {
    seed(CUSTOMER_ID, 'customer');

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { locale }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'locale', code: 'invalid' }] },
    });
    expect(fakes.accounts.get(CUSTOMER_ID)!.locale ?? null).toBeNull();
  });

  it('refuses an admin, a seller, an anonymous caller, an unverified or disabled customer', async () => {
    seed(ADMIN_ID, 'admin');
    seed(SELLER_ACCOUNT_ID, 'seller');
    seed(CUSTOMER_ID, 'customer', { status: 'disabled' });
    const unverified = id<'Account'>('01990000-0000-7000-8000-0000000000c2');
    seed(unverified, 'customer', { emailVerifiedAt: null });
    const input = { locale: 'ar' };
    const denied = { ok: false, error: { code: 'access.denied' } };

    await expect(useCase().execute(contextOf('admin', ADMIN_ID), input)).resolves.toEqual(denied);
    await expect(useCase().execute(contextOf('seller', SELLER_ACCOUNT_ID), input)).resolves.toEqual(
      denied,
    );
    await expect(useCase().execute(testCallContext(market, 'anonymous'), input)).resolves.toEqual({
      ok: false,
      error: { code: 'access.unauthenticated' },
    });
    await expect(useCase().execute(contextOf('customer', CUSTOMER_ID), input)).resolves.toEqual(
      denied,
    );
    await expect(useCase().execute(contextOf('customer', unverified), input)).resolves.toEqual(
      denied,
    );
    await expect(useCase().execute(contextOf('customer', ADMIN_ID), input)).resolves.toEqual(
      denied,
    );
    expect(fakes.accounts.get(ADMIN_ID)!.version).toBe(3);
  });
});
