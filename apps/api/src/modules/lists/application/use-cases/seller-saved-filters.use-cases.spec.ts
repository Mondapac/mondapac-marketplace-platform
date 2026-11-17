import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { MemorySavedFilterStore } from '../../../../../test/support/lists-fakes';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck, PermissionKey } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ListDefinition } from '../../contracts';
import { ListRegistry } from '../saved-filter-shared';
import { SellerSavedFilterCreate } from './seller-saved-filter-create.use-case';
import { SellerSavedFilterDelete } from './seller-saved-filter-delete.use-case';
import { SellerSavedFilterUpdate } from './seller-saved-filter-update.use-case';
import { SellerSavedFiltersList } from './seller-saved-filters-list.use-case';
import { SellerSavedFiltersReorder } from './seller-saved-filters-reorder.use-case';
import { SavedFilterCreate } from './saved-filter-create.use-case';

// The generic saved-filter use cases for the seller population (super list B0-1b, seller side),
// on both Market fixtures: a store-scoped list (Products) keeps its rows per store and may be
// shared with the store; an account-scoped list (Orders) keeps them per seller account across its
// stores and has no share key. An admin cannot use the seller routes nor a seller the admin ones,
// and an acting-as session is refused.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-17T00:00:00Z');
const key = (value: string) => value as PermissionKey;
const PRODUCTS = 'seller.catalog.products';
const ORDERS = 'seller.ordering.orders';
const ADMIN_PRODUCTS = 'admin.catalog.products';
const PRODUCTS_VIEW = 'catalog.own-product.view';
const PRODUCTS_SHARE = 'catalog.own-saved-filter.share';
const ORDERS_VIEW = 'ordering.seller-order.view';

const parsePayload: ListDefinition['parsePayload'] = (raw) =>
  typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === 1
    ? ok({ v: 1 })
    : err({ code: 'validation.failed', fields: [{ path: 'payload.v', code: 'value' }] });

const definitions: readonly ListDefinition[] = [
  {
    listKey: PRODUCTS,
    population: 'seller',
    scope: 'store',
    viewKey: key(PRODUCTS_VIEW),
    shareKey: key(PRODUCTS_SHARE),
    parsePayload,
  },
  {
    listKey: ORDERS,
    population: 'seller',
    scope: 'account',
    viewKey: key(ORDERS_VIEW),
    parsePayload,
  },
  {
    listKey: ADMIN_PRODUCTS,
    population: 'admin',
    viewKey: key('catalog.product.view'),
    shareKey: key('catalog.saved-filter.share'),
    parsePayload,
  },
];

describe.each(['AU', 'ZZ'] as const)('seller saved filters in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const STORE_A = ids.next<'Seller'>();
  const STORE_B = ids.next<'Seller'>();

  const member = (
    keys: readonly string[],
    sellerId = STORE_A,
    accountId = ids.next<'Account'>(),
  ) => {
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
    return { accountId, keys, context };
  };
  const adminCaller = () => {
    const accountId = ids.next<'Account'>();
    return {
      accountId,
      keys: ['catalog.product.view', 'catalog.saved-filter.share'],
      context: testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      ),
    };
  };

  function setup(options: { unavailable?: boolean } = {}) {
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const actor = context.actor;
        const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
        if (declaration.rule.kind !== 'permissions') return Promise.resolve({ allowed: true });
        if (options.unavailable === true) {
          return Promise.resolve({ allowed: false, denial: { code: 'access.unavailable' } });
        }
        return Promise.resolve(
          declaration.rule.allOf.every((needed) => keys.includes(needed))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const gate = createUseCaseGate(markets, check);
    const store = new MemorySavedFilterStore();
    const registry = new ListRegistry();
    registry.register('catalog', [definitions[0]!, definitions[2]!]);
    registry.register('ordering', [definitions[1]!]);
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_context, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const base = { unitOfWork, store, registry, authorisation: check };
    return {
      store,
      audits,
      create: new SellerSavedFilterCreate(gate, { ...base, audit, clock, ids }),
      adminCreate: new SavedFilterCreate(gate, { ...base, audit, clock, ids }),
      update: new SellerSavedFilterUpdate(gate, { ...base, audit, clock }),
      remove: new SellerSavedFilterDelete(gate, { ...base, audit }),
      list: new SellerSavedFiltersList(gate, base),
      reorder: new SellerSavedFiltersReorder(gate, base),
      as: (who: { accountId: string; keys: readonly string[]; context: CallContext }) => {
        held.set(who.accountId, who.keys);
        return who.context;
      },
    };
  }

  const body = (overrides: Record<string, unknown> = {}) => ({
    listKey: PRODUCTS,
    name: 'Paused',
    visibility: 'me',
    payload: { v: 1 },
    ...overrides,
  });
  const failure = (result: Result<unknown, { code: string }>) =>
    result.ok ? 'ok' : result.error.code;

  it('declares the seller routes open while the store is onboarding', () => {
    for (const useCase of [
      SellerSavedFilterCreate,
      SellerSavedFilterUpdate,
      SellerSavedFilterDelete,
      SellerSavedFiltersList,
      SellerSavedFiltersReorder,
    ]) {
      expect(useCase.access).toMatchObject({
        rule: { kind: 'own-resources' },
        whenSellerNotApproved: 'allow',
      });
      expect(useCase.access.name).toMatch(/^lists\.seller-saved-filters?-/);
    }
  });

  describe('a store-scoped list', () => {
    it('keeps the filter under the caller’s store', async () => {
      const { create, as, store } = setup();
      const result = await create.execute(as(member([PRODUCTS_VIEW])), body());
      expect(result.ok).toBe(true);
      expect([...store.rows.values()].map((row) => row.filter.sellerId)).toEqual([STORE_A]);
    });

    it('shows a shared filter to the store only, never to another store', async () => {
      const { create, list, as } = setup();
      const keys = [PRODUCTS_VIEW, PRODUCTS_SHARE];
      expect((await create.execute(as(member(keys)), body({ visibility: 'everyone' }))).ok).toBe(
        true,
      );
      const sameStore = await list.execute(as(member([PRODUCTS_VIEW])), { listKey: PRODUCTS });
      const otherStore = await list.execute(as(member([PRODUCTS_VIEW], STORE_B)), {
        listKey: PRODUCTS,
      });
      expect(sameStore.ok && sameStore.value.items.map((item) => item.name)).toEqual(['Paused']);
      expect(otherStore.ok && otherStore.value.items).toEqual([]);
    });

    it('needs the own share key for everyone, and audits what it shares', async () => {
      const { create, as, audits } = setup();
      expect(
        failure(
          await create.execute(as(member([PRODUCTS_VIEW])), body({ visibility: 'everyone' })),
        ),
      ).toBe('access.denied');
      await create.execute(
        as(member([PRODUCTS_VIEW, PRODUCTS_SHARE])),
        body({ visibility: 'everyone' }),
      );
      expect(audits.map((entry) => entry.action)).toEqual(['lists.saved-filter.shared']);
    });
  });

  describe('an account-scoped list', () => {
    it('keeps the filter for the account in every store and never for the store', async () => {
      const { create, list, as, store } = setup();
      const account = ids.next<'Account'>();
      const inA = member([ORDERS_VIEW], STORE_A, account);
      const inB = member([ORDERS_VIEW], STORE_B, account);
      await create.execute(as(inA), body({ listKey: ORDERS }));
      expect([...store.rows.values()].map((row) => row.filter.sellerId)).toEqual([null]);
      const seen = await list.execute(as(inB), { listKey: ORDERS });
      expect(seen.ok && seen.value.items.map((item) => item.name)).toEqual(['Paused']);
      const colleague = await list.execute(as(member([ORDERS_VIEW], STORE_A)), {
        listKey: ORDERS,
      });
      expect(colleague.ok && colleague.value.items).toEqual([]);
    });

    it('cannot be shared, whatever keys the caller holds', async () => {
      const { create, list, as, store } = setup();
      const who = member([ORDERS_VIEW, PRODUCTS_SHARE, 'ordering.saved-filter.share']);
      expect(
        failure(await create.execute(as(who), body({ listKey: ORDERS, visibility: 'everyone' }))),
      ).toBe('access.denied');
      expect(store.rows.size).toBe(0);
      const listed = await list.execute(as(who), { listKey: ORDERS });
      expect(listed.ok && listed.value.canShare).toBe(false);
    });
  });

  describe('who may call', () => {
    it('refuses an admin on the seller routes and a seller on the admin routes', async () => {
      const { create, adminCreate, as, store } = setup();
      expect(failure(await create.execute(as(adminCaller()), body()))).toBe('access.denied');
      expect(
        failure(
          await adminCreate.execute(as(member([PRODUCTS_VIEW])), body({ listKey: ADMIN_PRODUCTS })),
        ),
      ).toBe('access.denied');
      expect(store.rows.size).toBe(0);
    });

    it('does not answer an admin list from the seller routes, nor the other way round', async () => {
      const { create, adminCreate, as } = setup();
      expect(
        failure(
          await create.execute(as(member([PRODUCTS_VIEW])), body({ listKey: ADMIN_PRODUCTS })),
        ),
      ).toBe('validation.failed');
      expect(
        failure(await adminCreate.execute(as(adminCaller()), body({ listKey: PRODUCTS }))),
      ).toBe('validation.failed');
    });

    it('refuses an acting-as (Login as Seller) session before anything is written', async () => {
      const { create, as, store } = setup();
      const who = member([PRODUCTS_VIEW]);
      const acting: CallContext = {
        ...as(who),
        actor: { ...who.context.actor, actingAs: { adminAccountId: ids.next() } } as never,
      };
      expect(failure(await create.execute(acting, body()))).toMatch(
        /^access\.(denied|acting-as-refused)$/,
      );
      expect(store.rows.size).toBe(0);
    });

    it('refuses a seller who cannot view the list, and fails closed when the port is down', async () => {
      const { create, as, store } = setup();
      expect(failure(await create.execute(as(member([])), body()))).toBe('access.denied');
      const down = setup({ unavailable: true });
      expect(failure(await down.create.execute(down.as(member([PRODUCTS_VIEW])), body()))).toBe(
        'access.unavailable',
      );
      expect(store.rows.size + down.store.rows.size).toBe(0);
    });
  });

  describe('update, delete and reorder', () => {
    it('lets the owner rename and delete, and never another store’s filter', async () => {
      const { create, update, remove, as } = setup();
      const owner = member([PRODUCTS_VIEW]);
      const created = await create.execute(as(owner), body());
      const id = created.ok ? created.value.id : '';
      const stranger = member([PRODUCTS_VIEW], STORE_B);
      expect(
        failure(
          await update.execute(as(stranger), {
            listKey: PRODUCTS,
            id,
            name: 'Taken',
            visibility: 'me',
          }),
        ),
      ).toBe('saved-filter.not-found');
      expect(
        failure(
          await update.execute(as(owner), {
            listKey: PRODUCTS,
            id,
            name: 'Renamed',
            visibility: 'me',
          }),
        ),
      ).toBe('ok');
      expect(failure(await remove.execute(as(stranger), { listKey: PRODUCTS, id }))).toBe(
        'saved-filter.not-found',
      );
      expect(failure(await remove.execute(as(owner), { listKey: PRODUCTS, id }))).toBe('ok');
    });

    it('puts the caller’s own filters in a new order within the store', async () => {
      const { create, reorder, list, as } = setup();
      const owner = member([PRODUCTS_VIEW]);
      const first = await create.execute(as(owner), body({ name: 'One' }));
      const second = await create.execute(as(owner), body({ name: 'Two' }));
      const ids2 = [second, first].map((r) => (r.ok ? r.value.id : ''));
      expect(failure(await reorder.execute(as(owner), { listKey: PRODUCTS, ids: ids2 }))).toBe(
        'ok',
      );
      const listed = await list.execute(as(owner), { listKey: PRODUCTS });
      expect(listed.ok && listed.value.items.map((item) => item.name)).toEqual(['Two', 'One']);
    });
  });
});
