import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CartState } from '../domain/cart';
import { CartAdminFacadeImplementation } from '../presentation/cart-admin.facade';
import type { AdminCartDependencies } from './admin-customer-cart';
import { InMemorySavedItems } from './testing/in-memory-saved-items';
import { AdminCustomerCartRead } from './use-cases/admin-customer-cart.use-case';
import { AdminCustomerSavedItems } from './use-cases/admin-customer-saved-items.use-case';

// The admin's reads of one customer's cart (customers management phase 2b) on both Market
// fixtures: the active cart and the saved-for-later list of that account in this Market only,
// both paging modes, ids and quantities only, and a platform admin only.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
const T0 = Temporal.Instant.from('2026-11-16T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const OTHER = id<'Account'>(0xc2);

describe.each([['AU'], ['ZZ']] as const)('the admin’s read of a customer’s cart in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const elsewhere = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: id<'Account'>(0xa1),
        sessionId: id<'Session'>(0xa2),
        sellerId: null,
      }),
    );

  const cartOf = (marketId: MarketContext, accountId: Id<'Account'>, n: number): CartState => ({
    id: id<'Cart'>(0x100 + n),
    marketId: marketId.marketId,
    owner: { kind: 'account', accountId },
    status: 'active',
    lastChangedAt: T0.add({ hours: n }),
    mergedIntoCartId: null,
    mergedAt: null,
    version: 1,
    createdAt: T0,
    lines: [
      {
        id: id<'CartLine'>(0x200 + n),
        offerId: id<'Offer'>(0x300 + n),
        variantId: id<'Variant'>(0x400 + n),
        quantity: 2,
        priceAtAdd: money(1250n, currency),
        addedAt: T0.add({ minutes: n }),
      },
    ],
  });

  function setUp() {
    const carts = [cartOf(market, CUSTOMER, 1), cartOf(elsewhere, CUSTOMER, 2)];
    const saved = new InMemorySavedItems();
    const deps: AdminCartDependencies = {
      unitOfWork: new FakeUnitOfWork(),
      carts: {
        findActiveByAccount: (m, accountId) =>
          Promise.resolve(
            carts.find(
              (c) =>
                c.marketId === m.marketId &&
                c.owner.kind === 'account' &&
                c.owner.accountId === accountId,
            ) ?? null,
          ),
      },
      saved,
    };
    const facade = new CartAdminFacadeImplementation(
      new AdminCustomerCartRead(gate, deps),
      new AdminCustomerSavedItems(gate, deps),
    );
    return { facade, saved };
  }

  async function save(
    saved: InMemorySavedItems,
    m: MarketContext,
    accountId: Id<'Account'>,
    n: number,
  ) {
    await saved.upsert(m, {
      id: id<'SavedItem'>(0x500 + n),
      accountId,
      offerId: id<'Offer'>(0x600 + n),
      variantId: id<'Variant'>(0x700 + n),
      savedAt: T0.add({ hours: n }),
    });
  }

  it('reads the customer’s active cart of this Market and the saved count', async () => {
    const { facade, saved } = setUp();
    await save(saved, market, CUSTOMER, 1);
    await save(saved, elsewhere, CUSTOMER, 2);
    const read = await facade.adminCustomerCart(admin(), CUSTOMER);
    expect(read).toEqual({
      ok: true,
      value: {
        savedCount: 1,
        cart: {
          createdAt: T0.toString(),
          lastChangedAt: T0.add({ hours: 1 }).toString(),
          lines: [
            {
              offerId: id(0x301),
              variantId: id(0x401),
              quantity: 2,
              priceAtAdd: money(1250n, currency),
              addedAt: T0.add({ minutes: 1 }).toString(),
            },
          ],
        },
      },
    });
    expect(await facade.adminCustomerCart(admin(), OTHER)).toEqual({
      ok: true,
      value: { cart: null, savedCount: 0 },
    });
  });

  it('pages the saved-for-later list, newest first or oldest first', async () => {
    const { facade, saved } = setUp();
    for (const n of [1, 2, 3]) await save(saved, market, CUSTOMER, n);
    await save(saved, market, OTHER, 9);
    const first = await facade.adminCustomerSavedItems(admin(), {
      accountId: CUSTOMER,
      direction: 'desc',
      window: { offset: 0, limit: 2 },
      withTotal: true,
    });
    expect(first.ok && first.value.total).toBe(3);
    expect(first.ok && first.value.rows.map((r) => r.offerId)).toEqual([id(0x603), id(0x602)]);
    const next = await facade.adminCustomerSavedItems(admin(), {
      accountId: CUSTOMER,
      direction: 'asc',
      window: { offset: 2, limit: 2 },
      withTotal: false,
    });
    expect(next).toEqual({
      ok: true,
      value: {
        total: null,
        rows: [
          {
            savedItemId: id(0x503),
            offerId: id(0x603),
            variantId: id(0x703),
            savedAt: T0.add({ hours: 3 }).toString(),
          },
        ],
      },
    });
  });

  it('refuses everyone but a platform admin', async () => {
    const { facade } = setUp();
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: CUSTOMER,
        sessionId: id<'Session'>(0xa3),
        sellerId: null,
      }),
    );
    for (const context of [testCallContext(market, 'system'), customer]) {
      expect(await facade.adminCustomerCart(context, CUSTOMER)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
  });

  it('declares the cart key only', () => {
    for (const type of [AdminCustomerCartRead, AdminCustomerSavedItems]) {
      expect(type.access.rule).toEqual({ kind: 'permissions', allOf: ['cart.customer-cart.view'] });
    }
  });
});
