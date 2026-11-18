import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryColumnPreferenceStore } from '../../../../../test/support/lists-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck, PermissionKey } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ListDefinition } from '../../contracts';
import { callerOf, ListRegistry } from '../saved-filter-shared';
import { ColumnPreferenceSave } from './column-preference-save.use-case';
import { SellerColumnPreferenceGet } from './seller-column-preference-get.use-case';
import { SellerColumnPreferenceReset } from './seller-column-preference-reset.use-case';
import { SellerColumnPreferenceSave } from './seller-column-preference-save.use-case';

// The column choice of a seller per list in memory (super list B0-2, seller side), on both Market
// fixtures: a store-scoped list keeps one choice per member and store, an account-scoped list one
// per account; the list's view key is asked (fail closed); the vocabulary is the list's; admin and
// seller never reach each other's lists. The SQL is in test/db/lists-seller-column-preferences.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-18T00:00:00Z');
const key = (value: string) => value as PermissionKey;
const PRODUCTS = 'seller.catalog.products';
const ORDERS = 'seller.ordering.orders';
const ADMIN_PRODUCTS = 'admin.catalog.products';
const PRODUCTS_VIEW = 'catalog.own-product.view';
const ORDERS_VIEW = 'ordering.seller-order.view';
const parsePayload: ListDefinition['parsePayload'] = () => ok({ v: 1 });

const definitions: readonly ListDefinition[] = [
  {
    listKey: PRODUCTS,
    population: 'seller',
    scope: 'store',
    viewKey: key(PRODUCTS_VIEW),
    columns: ['code', 'updated', 'offers'],
    parsePayload,
  },
  {
    listKey: ORDERS,
    population: 'seller',
    scope: 'account',
    viewKey: key(ORDERS_VIEW),
    columns: ['paid', 'total'],
    parsePayload,
  },
  {
    listKey: ADMIN_PRODUCTS,
    population: 'admin',
    viewKey: key('catalog.product.view'),
    columns: ['code'],
    parsePayload,
  },
];

const failure = (result: Result<unknown, { code: string }>) =>
  result.ok ? 'ok' : result.error.code;

describe.each(['AU', 'ZZ'] as const)('seller column preferences in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const STORE_A = ids.next<'Seller'>();
  const STORE_B = ids.next<'Seller'>();

  const member = (
    keys: readonly string[],
    sellerId = STORE_A,
    accountId = ids.next<'Account'>(),
  ) => ({
    accountId,
    keys,
    context: testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    ),
  });
  const admin = () => {
    const accountId = ids.next<'Account'>();
    return {
      accountId,
      keys: ['catalog.product.view'],
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
    const store = new MemoryColumnPreferenceStore();
    const registry = new ListRegistry();
    registry.register('catalog', [definitions[0]!, definitions[2]!]);
    registry.register('ordering', [definitions[1]!]);
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const base = { unitOfWork, store, registry, authorisation: check };
    return {
      store,
      get: new SellerColumnPreferenceGet(gate, base),
      save: new SellerColumnPreferenceSave(gate, { ...base, clock, ids }),
      reset: new SellerColumnPreferenceReset(gate, base),
      adminSave: new ColumnPreferenceSave(gate, { ...base, clock, ids }),
      as: (who: { accountId: string; keys: readonly string[]; context: CallContext }) => {
        held.set(who.accountId, who.keys);
        return who.context;
      },
    };
  }

  it('declares the seller routes open while the store is onboarding', () => {
    for (const useCase of [
      SellerColumnPreferenceGet,
      SellerColumnPreferenceSave,
      SellerColumnPreferenceReset,
    ]) {
      expect(useCase.access).toMatchObject({
        rule: { kind: 'own-resources' },
        whenSellerNotApproved: 'allow',
      });
    }
  });

  it('keeps a store-scoped choice per store: another store of the same account sees none', async () => {
    const { get, save, as, store } = setup();
    const account = ids.next<'Account'>();
    const inA = member([PRODUCTS_VIEW], STORE_A, account);
    const inB = member([PRODUCTS_VIEW], STORE_B, account);
    const saved = await save.execute(as(inA), { listKey: PRODUCTS, columns: ['offers', 'code'] });
    expect(saved.ok && saved.value.columns).toEqual(['offers', 'code']);
    expect([...store.rows.values()].map((row) => row.sellerId)).toEqual([STORE_A]);
    const here = await get.execute(as(inA), { listKey: PRODUCTS });
    const there = await get.execute(as(inB), { listKey: PRODUCTS });
    expect(here.ok && here.value.columns).toEqual(['offers', 'code']);
    expect(there.ok && there.value.columns).toBeNull();
  });

  it('keeps an account-scoped choice for the account in every store, never for a colleague', async () => {
    const { get, save, as, store } = setup();
    const account = ids.next<'Account'>();
    await save.execute(as(member([ORDERS_VIEW], STORE_A, account)), {
      listKey: ORDERS,
      columns: ['total'],
    });
    expect([...store.rows.values()].map((row) => row.sellerId)).toEqual([null]);
    const elsewhere = await get.execute(as(member([ORDERS_VIEW], STORE_B, account)), {
      listKey: ORDERS,
    });
    const colleague = await get.execute(as(member([ORDERS_VIEW], STORE_A)), { listKey: ORDERS });
    expect(elsewhere.ok && elsewhere.value.columns).toEqual(['total']);
    expect(colleague.ok && colleague.value.columns).toBeNull();
  });

  it('judges the view key before the ids, and refuses an id the list does not offer', async () => {
    const { save, as, store } = setup();
    expect(
      failure(await save.execute(as(member([])), { listKey: PRODUCTS, columns: ['nope'] })),
    ).toBe('access.denied');
    const viewer = member([PRODUCTS_VIEW]);
    expect(failure(await save.execute(as(viewer), { listKey: PRODUCTS, columns: ['nope'] }))).toBe(
      'validation.failed',
    );
    expect(
      failure(await save.execute(as(viewer), { listKey: PRODUCTS, columns: ['code', 'code'] })),
    ).toBe('validation.failed');
    expect(store.rows.size).toBe(0);
  });

  it('resets to the default and fails closed when the port is down', async () => {
    const { get, save, reset, as } = setup();
    const who = member([PRODUCTS_VIEW]);
    await save.execute(as(who), { listKey: PRODUCTS, columns: ['code'] });
    expect((await reset.execute(as(who), { listKey: PRODUCTS })).ok).toBe(true);
    const after = await get.execute(as(who), { listKey: PRODUCTS });
    expect(after.ok && after.value.columns).toBeNull();
    const down = setup({ unavailable: true });
    expect(failure(await down.get.execute(down.as(who), { listKey: PRODUCTS }))).toBe(
      'access.unavailable',
    );
  });

  it('names an acting-as marker on a minted seller actor access.acting-as-refused', () => {
    const who = member([PRODUCTS_VIEW]);
    const actor = Object.assign(
      Object.create(Object.getPrototypeOf(who.context.actor) as object | null),
      {
        ...who.context.actor,
        actingAs: { adminAccountId: ids.next() },
      },
    ) as CallContext['actor'];
    expect(callerOf({ ...who.context, actor }, 'seller')).toEqual({
      ok: false,
      error: { code: 'access.acting-as-refused' },
    });
    expect(callerOf(who.context, 'seller').ok).toBe(true);
  });

  it('keeps admin and seller apart in both directions', async () => {
    const { save, adminSave, as, store } = setup();
    expect(failure(await save.execute(as(admin()), { listKey: PRODUCTS, columns: ['code'] }))).toBe(
      'access.denied',
    );
    expect(
      failure(
        await save.execute(as(member([PRODUCTS_VIEW])), {
          listKey: ADMIN_PRODUCTS,
          columns: ['code'],
        }),
      ),
    ).toBe('validation.failed');
    expect(
      failure(await adminSave.execute(as(admin()), { listKey: PRODUCTS, columns: ['code'] })),
    ).toBe('validation.failed');
    expect(store.rows.size).toBe(0);
  });
});
