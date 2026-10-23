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
import { ChangeStorefrontAppearance } from './change-storefront-appearance.use-case';

// A customer keeps the own storefront look on the account (buyer account backend), for both
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

describe.each(TEST_MARKETS)('ChangeStorefrontAppearance in market %s', (code) => {
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
    new ChangeStorefrontAppearance(gate, {
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
    expect(ChangeStorefrontAppearance.access).toEqual({
      name: 'identity.change-storefront-appearance',
      rule: { kind: 'own-resources' },
      whenSellerNotApproved: 'deny',
    });
  });

  it('keeps the palette and text size of the own customer account', async () => {
    seed(CUSTOMER_ID, 'customer');

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { palette: 'C', textSize: 'large' }),
    ).resolves.toEqual({
      ok: true,
      value: { code: 'storefront-appearance-changed', changed: true },
    });

    expect(fakes.accounts.get(CUSTOMER_ID)).toMatchObject({
      appearance: { palette: 'C', textSize: 'large' },
      version: 4,
    });
  });

  it('changes nothing for the same values, and clears a part with null', async () => {
    seed(CUSTOMER_ID, 'customer', { appearance: { palette: 'D', textSize: 'small' } });

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { palette: 'D', textSize: 'small' }),
    ).resolves.toEqual({
      ok: true,
      value: { code: 'storefront-appearance-changed', changed: false },
    });
    expect(fakes.accounts.get(CUSTOMER_ID)!.version).toBe(3);

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { palette: null, textSize: 'small' }),
    ).resolves.toMatchObject({ ok: true, value: { changed: true } });
    expect(fakes.accounts.get(CUSTOMER_ID)!.appearance).toEqual({
      palette: null,
      textSize: 'small',
    });
  });

  it.each([
    [{ palette: 'E', textSize: null }, 'palette'],
    [{ palette: 'b', textSize: null }, 'palette'],
    [{ palette: '', textSize: null }, 'palette'],
    [{ palette: null, textSize: 'huge' }, 'textSize'],
    [{ palette: null, textSize: 'Auto' }, 'textSize'],
  ] as const)('refuses %j with a problem on %s', async (input, path) => {
    seed(CUSTOMER_ID, 'customer');

    await expect(useCase().execute(contextOf('customer', CUSTOMER_ID), input)).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: 'invalid' }] },
    });
    expect(fakes.accounts.get(CUSTOMER_ID)!.appearance ?? null).toBeNull();
  });

  it('refuses an admin, a seller, an anonymous caller, an unverified or disabled customer and another population', async () => {
    seed(ADMIN_ID, 'admin');
    seed(SELLER_ACCOUNT_ID, 'seller');
    seed(CUSTOMER_ID, 'customer', { status: 'disabled' });
    const unverified = id<'Account'>('01990000-0000-7000-8000-0000000000c2');
    seed(unverified, 'customer', { emailVerifiedAt: null });
    const input = { palette: 'A', textSize: null };
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
    // A customer session naming an admin account (a forged or stale actor) is refused too.
    await expect(useCase().execute(contextOf('customer', ADMIN_ID), input)).resolves.toEqual(
      denied,
    );
    expect(fakes.accounts.get(ADMIN_ID)!.version).toBe(3);
  });
});
