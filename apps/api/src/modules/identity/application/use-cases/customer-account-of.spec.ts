import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../../test/support/pricing-fakes';
import { openGate } from '../../../../../test/support/system-only-denial';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import type { AccountRepository } from '../ports/account.repository';
import { CustomerAccountOf } from './customer-account-of.use-case';

// `customerAccountOf` (wallet review S1): whether an id names an active customer account of the
// context's Market, for an admin. Fake account store; both Markets.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const SELLER = id<'Account'>(0xb1);
const ADMIN = id<'Account'>(0xa1);
const FOREIGN = id<'Account'>(0xc2);
const CLOSED = id<'Account'>(0xc3);
const UNKNOWN = id<'Account'>(0xc4);

describe.each(TEST_MARKETS)('identity.customer-account-of in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = TEST_MARKETS.find((m) => m !== code)!;
  const rows = new Map<string, { marketId: string; population: string; status: string }>([
    [CUSTOMER, { marketId: code, population: 'customer', status: 'active' }],
    [SELLER, { marketId: code, population: 'seller', status: 'active' }],
    [ADMIN, { marketId: code, population: 'admin', status: 'active' }],
    [FOREIGN, { marketId: other, population: 'customer', status: 'active' }],
    [CLOSED, { marketId: code, population: 'customer', status: 'disabled' }],
  ]);
  let failing: boolean;
  let units: number;
  const accounts = {
    customerStatus: (m: MarketContext, accountId: Id<'Account'>) => {
      if (failing) return Promise.reject(new Error('database down'));
      const row = rows.get(accountId);
      return Promise.resolve(
        row === undefined || row.marketId !== m.marketId || row.population !== 'customer'
          ? null
          : row.status,
      );
    },
  } as unknown as AccountRepository;
  const unitOfWork = new FakeUnitOfWork();
  const counting = {
    run: (...args: Parameters<FakeUnitOfWork['run']>) => {
      units += 1;
      return unitOfWork.run(...args);
    },
  } as unknown as FakeUnitOfWork;
  const query = new CustomerAccountOf(openGate(), { unitOfWork: counting, accounts });

  const as = (population: 'customer' | 'seller' | 'admin', n: number): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id<'Account'>(n),
        sessionId: id<'Session'>(n + 0x100),
        sellerId: population === 'seller' ? id<'Seller'>(n + 0x200) : null,
      }),
      'customer-account-of-0001',
    );

  beforeEach(() => {
    failing = false;
    units = 0;
  });

  it('answers an active customer account of the Market, by id only', async () => {
    expect(await query.execute(as('admin', 0xa9), { accountId: CUSTOMER })).toEqual({
      ok: true,
      value: { accountId: CUSTOMER },
    });
  });

  it.each([
    ['an unknown id', UNKNOWN],
    ["a seller's account", SELLER],
    ["an admin's account", ADMIN],
    ["another Market's customer", FOREIGN],
    ['a closed customer account', CLOSED],
    ['a malformed id', 'not-an-id'],
  ])('answers %s as absent', async (_label, accountId) => {
    expect(await query.execute(as('admin', 0xa9), { accountId })).toEqual({
      ok: true,
      value: null,
    });
  });

  it('refuses a customer, a seller, the system actor and an acting-as session, with no read', async () => {
    const admin = as('admin', 0xa9);
    const actingAs = {
      ...admin,
      actor: { ...admin.actor, actingAs: { adminAccountId: id<'Account'>(0xa9) } },
    } as unknown as CallContext;
    for (const context of [
      as('customer', 0xc9),
      as('seller', 0xb9),
      testCallContext(market, 'system', 'customer-account-of-0002'),
      actingAs,
    ]) {
      expect(await query.execute(context, { accountId: CUSTOMER })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    expect(units).toBe(0);
  });

  it('fails closed when the read fails', async () => {
    failing = true;
    expect(await query.execute(as('admin', 0xa9), { accountId: CUSTOMER })).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });
});
