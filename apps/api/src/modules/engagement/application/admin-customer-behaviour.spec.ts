import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { BehaviourFacts } from '../domain/behaviour-event';
import { CustomerBehaviourFacadeImplementation } from '../presentation/customer-behaviour.facade';
import type { EngagementDependencies } from './engagement-dependencies';
import {
  FakeEngagementGuestTokens,
  InMemoryBehaviourEvents,
  InMemoryPersonalizationSettings,
} from './testing/in-memory-engagement';
import { AdminCustomerBehaviour } from './use-cases/admin-customer-behaviour.use-case';
import { AdminCustomerCartAdditions } from './use-cases/admin-customer-cart-additions.use-case';

// The admin's reads of one customer's behaviour (customers management phase 2b) on both Market
// fixtures: the switch, counts by kind and the most viewed categories of the 12 months kept,
// never the search text; the add-to-cart history in both paging modes and a range; the
// customer's own rows of this Market only; a platform admin only.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
const NOW = Temporal.Instant.from('2026-11-16T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const OTHER = id<'Account'>(0xc2);
const CAT_A = id<'Category'>(0x401);
const CAT_B = id<'Category'>(0x402);

describe.each([['AU'], ['ZZ']] as const)(
  'the admin’s read of a customer’s behaviour in %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const elsewhere = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
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

    function setUp() {
      const events = new InMemoryBehaviourEvents();
      const settings = new InMemoryPersonalizationSettings();
      const clock = new FixedClock(NOW);
      const deps: EngagementDependencies = {
        unitOfWork: new FakeUnitOfWork(),
        events,
        settings,
        guestTokens: new FakeEngagementGuestTokens(),
        ids: new SequenceIdGenerator(clock),
        clock,
      };
      const facade = new CustomerBehaviourFacadeImplementation(
        new AdminCustomerBehaviour(gate, deps),
        new AdminCustomerCartAdditions(gate, deps),
      );
      let n = 0;
      const add = (
        m: MarketContext,
        accountId: Id<'Account'>,
        facts: BehaviourFacts,
        hoursAgo: number,
      ) => {
        n += 1;
        return events.append(m, {
          id: id<'BehaviourEvent'>(0x1000 + n),
          subject: { kind: 'account', accountId },
          facts,
          occurredAt: NOW.subtract({ hours: hoursAgo }),
        });
      };
      return { facade, settings, add };
    }

    const addition = (n: number): BehaviourFacts => ({
      kind: 'added-to-cart',
      offerId: id<'Offer'>(0x200 + n),
      variantId: id<'Variant'>(0x300 + n),
    });

    it('summarises the 12 months kept in counts and category ids, never the search text', async () => {
      const { facade, settings, add } = setUp();
      await add(market, CUSTOMER, { kind: 'category-viewed', categoryId: CAT_B }, 1);
      await add(market, CUSTOMER, { kind: 'category-viewed', categoryId: CAT_A }, 2);
      await add(market, CUSTOMER, { kind: 'category-viewed', categoryId: CAT_A }, 3);
      await add(
        market,
        CUSTOMER,
        { kind: 'product-viewed', productId: id(0x101), offerId: null },
        4,
      );
      await add(market, CUSTOMER, { kind: 'search-performed', query: 'secret lamb query' }, 5);
      await add(market, CUSTOMER, addition(1), 6);
      await add(market, CUSTOMER, { kind: 'category-viewed', categoryId: CAT_B }, 24 * 400);
      await add(elsewhere, CUSTOMER, { kind: 'category-viewed', categoryId: CAT_B }, 1);
      await add(market, OTHER, { kind: 'category-viewed', categoryId: CAT_B }, 1);
      await settings.save(market, {
        id: id<'PersonalizationSetting'>(0x9),
        accountId: CUSTOMER,
        enabled: false,
        changedAt: NOW.subtract({ hours: 7 }),
        createdAt: NOW.subtract({ hours: 7 }),
      });
      const read = await facade.adminCustomerBehaviour(admin(), CUSTOMER);
      expect(read).toEqual({
        ok: true,
        value: {
          personalization: { enabled: false, changedAt: NOW.subtract({ hours: 7 }).toString() },
          summary: {
            productViews: 1,
            categoryViews: 3,
            cartAdditions: 1,
            topCategories: [
              { categoryId: CAT_A, views: 2 },
              { categoryId: CAT_B, views: 1 },
            ],
          },
        },
      });
      expect(JSON.stringify(read)).not.toContain('secret');
      expect(await facade.adminCustomerBehaviour(admin(), OTHER)).toMatchObject({
        ok: true,
        value: { personalization: { enabled: true, changedAt: null } },
      });
    });

    it('pages the add-to-cart history in a range, cut to the 12 months kept', async () => {
      const { facade, add } = setUp();
      for (const n of [1, 2, 3]) await add(market, CUSTOMER, addition(n), n);
      await add(market, CUSTOMER, addition(9), 24 * 400);
      await add(elsewhere, CUSTOMER, addition(8), 1);
      await add(market, OTHER, addition(7), 1);
      const request = {
        accountId: CUSTOMER,
        from: null,
        to: null,
        direction: 'desc' as const,
        window: { offset: 0, limit: 2 },
        withTotal: true,
      };
      const first = await facade.adminCustomerCartAdditions(admin(), request);
      expect(first).toEqual({
        ok: true,
        value: {
          total: 3,
          rows: [
            {
              offerId: id(0x201),
              variantId: id(0x301),
              addedAt: NOW.subtract({ hours: 1 }).toString(),
            },
            {
              offerId: id(0x202),
              variantId: id(0x302),
              addedAt: NOW.subtract({ hours: 2 }).toString(),
            },
          ],
        },
      });
      const ranged = await facade.adminCustomerCartAdditions(admin(), {
        ...request,
        from: NOW.subtract({ hours: 24 * 800 }),
        to: NOW.subtract({ hours: 1 }),
        direction: 'asc',
        window: { offset: 0, limit: 10 },
        withTotal: false,
      });
      expect(ranged.ok && ranged.value.total).toBeNull();
      expect(ranged.ok && ranged.value.rows.map((r) => r.offerId)).toEqual([id(0x203), id(0x202)]);
    });

    it('refuses everyone but a platform admin, and an acting-as session', async () => {
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
      const acting = admin();
      for (const context of [
        testCallContext(market, 'system'),
        customer,
        { ...acting, actor: { ...acting.actor, actingAs: { sellerId: 'x' } } as never },
      ]) {
        expect(await facade.adminCustomerBehaviour(context, CUSTOMER)).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });

    it('declares the engagement key only', () => {
      for (const type of [AdminCustomerBehaviour, AdminCustomerCartAdditions]) {
        expect(type.access.rule).toEqual({
          kind: 'permissions',
          allOf: ['engagement.customer-behaviour.view'],
        });
      }
    });
  },
);
