import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
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
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { AccountState } from '../../domain/account';
import { AdminRenameCustomer } from './admin-rename-customer.use-case';

// An admin renames a customer from the customer page (customers phase 2a), for both Market
// fixtures: only a platform admin not acting as a seller; only a customer account of the Market;
// the domain's rule for disabled and unverified accounts; the same name writes nothing; a change
// writes the event and an audit row without the name; a concurrent change is unavailable.

const START = Temporal.Instant.from('2026-11-15T10:00:00Z');
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

describe.each(TEST_MARKETS)('AdminRenameCustomer in market %s', (code) => {
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
      displayName: 'Amina Rahman',
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
    new AdminRenameCustomer(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      outbox: fakes.outbox,
      audit: fakes.audit,
      clock: new FixedClock(START),
    });
  const contextOf = (
    population: 'admin' | 'seller' | 'customer',
    accountId: Id<'Account'>,
    sellerId: Id<'Seller'> | null = population === 'seller' ? SELLER_ID : null,
  ) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, { population, accountId, sessionId: SESSION_ID, sellerId }),
    );
  const admin = () => contextOf('admin', ADMIN_ID);
  const events = () =>
    fakes.events.filter((e) => e.type === 'identity.account-display-name-changed.v1');

  it('renames a customer, records one event and an audit row without the name', async () => {
    seed(CUSTOMER_ID, 'customer');
    await expect(
      useCase().execute(admin(), { accountId: CUSTOMER_ID, displayName: '  Amina R. ' }),
    ).resolves.toEqual({ ok: true, value: { changed: true } });
    expect(fakes.accounts.get(CUSTOMER_ID)).toMatchObject({ displayName: 'Amina R.', version: 4 });
    expect(events()).toHaveLength(1);
    expect(fakes.audits.map((entry) => entry.action)).toEqual([
      'identity.account.renamed-by-admin',
    ]);
    expect(JSON.stringify([fakes.audits, events()])).not.toContain('Amina');
  });

  it('writes nothing for the same name', async () => {
    seed(CUSTOMER_ID, 'customer');
    await expect(
      useCase().execute(admin(), { accountId: CUSTOMER_ID, displayName: 'Amina Rahman' }),
    ).resolves.toEqual({ ok: true, value: { changed: false } });
    expect(events()).toEqual([]);
    expect(fakes.audits).toEqual([]);
  });

  it('refuses a customer and a seller', async () => {
    seed(CUSTOMER_ID, 'customer');
    for (const context of [
      contextOf('customer', CUSTOMER_ID),
      contextOf('seller', SELLER_ACCOUNT_ID),
    ]) {
      await expect(
        useCase().execute(context, { accountId: CUSTOMER_ID, displayName: 'X' }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    }
  });

  it('refuses an acting-as session', async () => {
    seed(CUSTOMER_ID, 'customer');
    const base = admin();
    const actingAs = {
      ...base,
      actor: { ...base.actor, actingAs: { accountId: SELLER_ACCOUNT_ID, sellerId: SELLER_ID } },
    } as unknown as CallContext;
    const result = await useCase().execute(actingAs, { accountId: CUSTOMER_ID, displayName: 'X' });
    expect(result.ok).toBe(false);
    expect(fakes.accounts.get(CUSTOMER_ID)).toMatchObject({ displayName: 'Amina Rahman' });
  });

  it('answers unknown alike for a seller, an admin and a missing account', async () => {
    seed(SELLER_ACCOUNT_ID, 'seller');
    seed(ADMIN_ID, 'admin');
    for (const accountId of [
      SELLER_ACCOUNT_ID,
      ADMIN_ID,
      id<'Account'>('01990000-0000-7000-8000-0000000000ff'),
    ]) {
      await expect(useCase().execute(admin(), { accountId, displayName: 'X' })).resolves.toEqual({
        ok: false,
        error: { code: 'account.unknown' },
      });
    }
  });

  it('keeps the name of a disabled or unverified account, and checks the name', async () => {
    seed(CUSTOMER_ID, 'customer', { status: 'disabled' });
    await expect(
      useCase().execute(admin(), { accountId: CUSTOMER_ID, displayName: 'New' }),
    ).resolves.toEqual({ ok: false, error: { code: 'account.not-eligible' } });
    await expect(
      useCase().execute(admin(), { accountId: CUSTOMER_ID, displayName: '   ' }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'displayName', code: 'length' }] },
    });
  });

  it('answers unavailable on a concurrent change', async () => {
    seed(CUSTOMER_ID, 'customer');
    const accounts = {
      ...fakes.accountRepository,
      save: () => Promise.reject(new StaleAggregateError('account', CUSTOMER_ID)),
    };
    const stale = new AdminRenameCustomer(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts,
      outbox: fakes.outbox,
      audit: fakes.audit,
      clock: new FixedClock(START),
    });
    await expect(
      stale.execute(admin(), { accountId: CUSTOMER_ID, displayName: 'New' }),
    ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
  });
});
