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
import { MAX_PREFERRED_COLUMNS } from '../../contracts';
import { ListRegistry } from '../saved-filter-shared';
import { ColumnPreferenceGet } from './column-preference-get.use-case';
import { ColumnPreferenceReset } from './column-preference-reset.use-case';
import { ColumnPreferenceSave } from './column-preference-save.use-case';

// The column choice of an admin per list in memory (super list B0-2), on both Market fixtures: the
// list's view key asked through the authorisation port (fail closed), the vocabulary of the list,
// a list with no column choice, the other population, the reset, and that one Market and one
// account never see another's choice. The SQL is in test/db/lists-column-preferences.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-15T00:00:00Z');
const key = (value: string) => value as PermissionKey;
const PRODUCTS = 'admin.catalog.products';
const ORDERS = 'admin.ordering.orders';
const SELLER_PRODUCTS = 'seller.catalog.products';
const PRODUCT_COLUMNS = ['code', 'offers', 'updated'];
const parsePayload: ListDefinition['parsePayload'] = () => ok({ v: 1 });

const definitions: readonly ListDefinition[] = [
  {
    listKey: PRODUCTS,
    population: 'admin',
    viewKey: key('catalog.product.view'),
    shareKey: key('catalog.saved-filter.share'),
    columns: PRODUCT_COLUMNS,
    parsePayload,
  },
  // A list that has saved filters but no column choice.
  {
    listKey: ORDERS,
    population: 'admin',
    viewKey: key('ordering.order.view'),
    shareKey: key('ordering.saved-filter.share'),
    parsePayload,
  },
  {
    listKey: SELLER_PRODUCTS,
    population: 'seller',
    viewKey: key('catalog.own-product.view'),
    shareKey: key('catalog.own-saved-filter.share'),
    columns: ['code'],
    parsePayload,
  },
];

const failure = (result: Result<unknown, { code: string }>) =>
  result.ok ? 'ok' : result.error.code;

describe.each(['AU', 'ZZ'] as const)('column preferences in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);

  const admin = (keys: readonly string[], inMarket: MarketContext = market) => {
    const accountId = ids.next<'Account'>();
    const context: CallContext = testCallContext(
      inMarket,
      testAuthenticatedActor(inMarket, {
        population: 'admin',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    return { accountId, context, keys };
  };

  function setup(options: { unavailable?: boolean; throws?: boolean } = {}) {
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        if (options.throws === true) return Promise.reject(new Error('down'));
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
    registry.register(
      'catalog',
      definitions.filter((d) => d.listKey.includes('.catalog.')),
    );
    registry.register(
      'ordering',
      definitions.filter((d) => d.listKey.includes('.ordering.')),
    );
    const isolations: (string | undefined)[] = [];
    const unitOfWork = {
      run: <T, E>(
        _m: MarketContext,
        work: () => Promise<Result<T, E>>,
        unit?: { isolation?: string },
      ) => {
        isolations.push(unit?.isolation);
        return work();
      },
    } as unknown as UnitOfWork;
    const base = { unitOfWork, store, registry, authorisation: check };
    return {
      store,
      isolations,
      get: new ColumnPreferenceGet(gate, base),
      save: new ColumnPreferenceSave(gate, { ...base, clock, ids }),
      reset: new ColumnPreferenceReset(gate, base),
      as: (who: ReturnType<typeof admin>) => {
        held.set(who.accountId, who.keys);
        return who.context;
      },
    };
  }

  const viewer = () => admin(['catalog.product.view']);
  const input = (columns: unknown, listKey: unknown = PRODUCTS) => ({ listKey, columns });

  it('answers null before a choice and the saved ids after, in a serializable unit', async () => {
    const { get, save, as, isolations } = setup();
    const who = viewer();

    const before = await get.execute(as(who), { listKey: PRODUCTS });
    isolations.length = 0;
    const saved = await save.execute(as(who), input(['updated', 'code']));
    const after = await get.execute(as(who), { listKey: PRODUCTS });

    expect(before.ok && before.value).toEqual({
      listKey: PRODUCTS,
      columns: null,
      available: PRODUCT_COLUMNS,
    });
    expect(saved.ok && saved.value.columns).toEqual(['updated', 'code']);
    expect(isolations).toEqual(['serializable']);
    expect(after.ok && after.value.columns).toEqual(['updated', 'code']);
  });

  it('replaces the choice on a second save, and an empty array is a choice', async () => {
    const { get, save, as, store } = setup();
    const who = viewer();
    await save.execute(as(who), input(['code']));

    await save.execute(as(who), input([]));
    const read = await get.execute(as(who), { listKey: PRODUCTS });

    expect(read.ok && read.value.columns).toEqual([]);
    expect(store.rows.size).toBe(1);
  });

  it('refuses ids outside the vocabulary, repeats, a non-array and too many ids', async () => {
    const { save, as, store } = setup();
    const who = viewer();
    const tooMany = Array.from({ length: MAX_PREFERRED_COLUMNS + 1 }, () => 'code');

    for (const columns of [['nope'], ['code', 'code'], 'code', [1], tooMany, null]) {
      expect(failure(await save.execute(as(who), input(columns)))).toBe('validation.failed');
    }
    expect(store.rows.size).toBe(0);
  });

  it('refuses an unknown list, one with no column choice, one of the other population, unknown fields', async () => {
    const { save, get, as } = setup();
    const who = admin(['catalog.product.view', 'ordering.order.view']);

    for (const listKey of ['admin.catalog.nothing', ORDERS, SELLER_PRODUCTS, 7, undefined]) {
      expect(failure(await save.execute(as(who), { listKey, columns: ['code'] }))).toBe(
        'validation.failed',
      );
      expect(failure(await get.execute(as(who), { listKey }))).toBe('validation.failed');
    }
    expect(failure(await save.execute(as(who), { ...input(['code']), extra: 1 } as never))).toBe(
      'validation.failed',
    );
    expect(failure(await get.execute(as(who), 'x' as never))).toBe('validation.failed');
  });

  it('asks the list view key before it reads or writes, and fails closed', async () => {
    const blind = admin([]);
    const denied = setup();
    expect(failure(await denied.get.execute(denied.as(blind), { listKey: PRODUCTS }))).toBe(
      'access.denied',
    );
    expect(failure(await denied.save.execute(denied.as(blind), input(['code'])))).toBe(
      'access.denied',
    );
    expect(failure(await denied.reset.execute(denied.as(blind), { listKey: PRODUCTS }))).toBe(
      'access.denied',
    );
    expect(denied.store.rows.size).toBe(0);

    for (const options of [{ unavailable: true }, { throws: true }]) {
      const down = setup(options);
      const who = viewer();
      expect(failure(await down.save.execute(down.as(who), input(['code'])))).toBe(
        'access.unavailable',
      );
      expect(failure(await down.get.execute(down.as(who), { listKey: PRODUCTS }))).toBe(
        'access.unavailable',
      );
      expect(down.store.rows.size).toBe(0);
    }
  });

  it('refuses a caller that is not an admin', async () => {
    const { save, get, reset } = setup();
    const accountId = ids.next<'Account'>();
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );
    expect(failure(await save.execute(seller, input(['code'])))).toBe('access.denied');
    expect(failure(await get.execute(seller, { listKey: PRODUCTS }))).toBe('access.denied');
    expect(failure(await reset.execute(seller, { listKey: PRODUCTS }))).toBe('access.denied');
  });

  it('resets to the default, and resetting nothing is fine', async () => {
    const { save, reset, get, as, store } = setup();
    const who = viewer();
    await save.execute(as(who), input(['code']));

    const first = await reset.execute(as(who), { listKey: PRODUCTS });
    const again = await reset.execute(as(who), { listKey: PRODUCTS });
    const read = await get.execute(as(who), { listKey: PRODUCTS });

    expect(first.ok && first.value.columns).toBeNull();
    expect(again.ok).toBe(true);
    expect(read.ok && read.value.columns).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it('keeps one account’s and one Market’s choice apart from another’s', async () => {
    const { save, get, as } = setup();
    const mine = viewer();
    const theirs = viewer();
    const elsewhere = admin(['catalog.product.view'], otherMarket);
    await save.execute(as(mine), input(['offers']));

    const other = await get.execute(as(theirs), { listKey: PRODUCTS });
    const crossMarket = await get.execute(as(elsewhere), { listKey: PRODUCTS });

    expect(other.ok && other.value.columns).toBeNull();
    expect(crossMarket.ok && crossMarket.value.columns).toBeNull();
  });

  it('drops a saved id the list no longer offers when it reads', async () => {
    const { get, as, store } = setup();
    const who = viewer();
    await store.put(market, {
      id: ids.next<'ColumnPreference'>(),
      listKey: PRODUCTS,
      ownerAccountId: who.accountId,
      sellerId: null,
      columns: ['code', 'retired', 'offers'],
      createdAt: T0,
      updatedAt: T0,
    });

    const read = await get.execute(as(who), { listKey: PRODUCTS });

    expect(read.ok && read.value.columns).toEqual(['code', 'offers']);
  });

  it('refuses a list whose column vocabulary repeats an id or has too many', () => {
    const base = definitions[0]!;
    expect(() =>
      new ListRegistry().register('catalog', [{ ...base, columns: ['code', 'code'] }]),
    ).toThrow('column vocabulary');
    expect(() =>
      new ListRegistry().register('catalog', [
        { ...base, columns: Array.from({ length: MAX_PREFERRED_COLUMNS + 1 }, (_, i) => `c${i}`) },
      ]),
    ).toThrow('column vocabulary');
  });

  it('asks the view key before it judges the column ids', async () => {
    const { save, as } = setup();
    const blind = admin([]);
    expect(failure(await save.execute(as(blind), input(['nope'])))).toBe('access.denied');
  });
});
