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
import { MAX_SAVED_FILTERS_PER_OWNER, MAX_SHARED_SAVED_FILTERS } from '../../contracts';
import { ListRegistry } from '../saved-filter-shared';
import { SavedFilterCreate } from './saved-filter-create.use-case';
import { SavedFilterDelete } from './saved-filter-delete.use-case';
import { SavedFilterUpdate } from './saved-filter-update.use-case';
import { SavedFiltersList } from './saved-filters-list.use-case';
import { SavedFiltersReorder } from './saved-filters-reorder.use-case';

// The generic saved-filter use cases in memory (super list B0-1b), on both Market fixtures: the
// per-list view and share keys asked through the authorisation port (fail closed), the lists of
// other lists and populations, the caps, the names, the audit rows for filters shared with
// everyone, the reorder, and that one Market never sees another's rows. The SQL behaviour is in
// test/db/lists-saved-filters.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-15T00:00:00Z');
const key = (value: string) => value as PermissionKey;
const PRODUCTS = 'admin.catalog.products';
const ORDERS = 'admin.ordering.orders';
const SELLER_PRODUCTS = 'seller.catalog.products';
const PRODUCTS_VIEW = 'catalog.product.view';
const PRODUCTS_SHARE = 'catalog.saved-filter.share';
const ORDERS_VIEW = 'ordering.order.view';
const ORDERS_SHARE = 'ordering.saved-filter.share';

const parsePayload: ListDefinition['parsePayload'] = (raw) =>
  typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === 1
    ? ok({ v: 1 })
    : err({ code: 'validation.failed', fields: [{ path: 'payload.v', code: 'value' }] });

const definitions: readonly ListDefinition[] = [
  {
    listKey: PRODUCTS,
    population: 'admin',
    viewKey: key(PRODUCTS_VIEW),
    shareKey: key(PRODUCTS_SHARE),
    parsePayload,
  },
  {
    listKey: ORDERS,
    population: 'admin',
    viewKey: key(ORDERS_VIEW),
    shareKey: key(ORDERS_SHARE),
    parsePayload,
  },
  {
    listKey: SELLER_PRODUCTS,
    population: 'seller',
    viewKey: key('catalog.own-product.view'),
    shareKey: key('catalog.own-saved-filter.share'),
    parsePayload,
  },
];

describe.each(['AU', 'ZZ'] as const)('generic saved filters in market %s', (code) => {
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
  const productsOnly = () => admin([PRODUCTS_VIEW]);
  const productsModerator = () => admin([PRODUCTS_VIEW, PRODUCTS_SHARE]);

  function setup(options: { unavailable?: boolean } = {}) {
    const held = new Map<string, readonly string[]>();
    const asked: string[][] = [];
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const actor = context.actor;
        const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
        if (declaration.rule.kind !== 'permissions') {
          return Promise.resolve({ allowed: true });
        }
        asked.push([...declaration.rule.allOf]);
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
    registry.register(
      'catalog',
      definitions.filter((d) => d.listKey.includes('.catalog.')),
    );
    registry.register(
      'ordering',
      definitions.filter((d) => d.listKey.includes('.ordering.')),
    );
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
      asked,
      create: new SavedFilterCreate(gate, { ...base, audit, clock, ids }),
      update: new SavedFilterUpdate(gate, { ...base, audit, clock }),
      remove: new SavedFilterDelete(gate, { ...base, audit }),
      list: new SavedFiltersList(gate, base),
      reorder: new SavedFiltersReorder(gate, base),
      as: (who: ReturnType<typeof admin>) => {
        held.set(who.accountId, who.keys);
        return who.context;
      },
    };
  }

  const body = (overrides: Record<string, unknown> = {}) => ({
    listKey: PRODUCTS,
    name: 'Meat, active',
    visibility: 'me',
    payload: { v: 1 },
    ...overrides,
  });
  const failure = (result: Result<unknown, { code: string }>) =>
    result.ok ? 'ok' : result.error.code;

  describe('registry', () => {
    it('refuses a list registered twice, outside its owner, or missing from the audit vocabulary', () => {
      const registry = new ListRegistry();
      const first = definitions[0]!;
      registry.register('catalog', [first]);
      expect(() => registry.register('catalog', [first])).toThrow('registered twice');
      expect(() => new ListRegistry().register('ordering', [first])).toThrow('must start with');
      expect(() =>
        new ListRegistry().register('catalog', [{ ...first, listKey: 'admin.catalog.unknown' }]),
      ).toThrow('audit vocabulary');
    });

    it('does not answer a list of the other population', async () => {
      const { create, as } = setup();
      const result = await create.execute(as(productsOnly()), body({ listKey: SELLER_PRODUCTS }));
      expect(failure(result)).toBe('validation.failed');
    });
  });

  describe('create', () => {
    it('saves a private filter for an admin who may view the list, without an audit row', async () => {
      const { create, as, audits, store } = setup();
      const who = productsOnly();

      const result = await create.execute(as(who), body());

      expect(result.ok && result.value).toMatchObject({
        listKey: PRODUCTS,
        name: 'Meat, active',
        visibility: 'me',
        ownedByMe: true,
        canManage: true,
        position: 1,
      });
      expect(store.rows.size).toBe(1);
      expect(audits).toEqual([]);
    });

    it('asks the view key of the named list, not of another one', async () => {
      const { create, as, asked } = setup();
      await create.execute(as(productsOnly()), body({ listKey: ORDERS }));
      expect(asked[0]).toEqual([ORDERS_VIEW]);
    });

    it('refuses an admin who cannot view the list, before anything is written', async () => {
      const { create, as, store } = setup();
      const result = await create.execute(as(productsOnly()), body({ listKey: ORDERS }));
      expect(failure(result)).toBe('access.denied');
      expect(store.rows.size).toBe(0);
    });

    it('fails closed when the authorisation port cannot answer', async () => {
      const { create, as, store } = setup({ unavailable: true });
      const result = await create.execute(as(productsOnly()), body());
      expect(failure(result)).toBe('access.unavailable');
      expect(store.rows.size).toBe(0);
    });

    it('needs the share key of that list for everyone, and audits what it shares', async () => {
      const { create, as, audits } = setup();
      expect(
        failure(await create.execute(as(productsOnly()), body({ visibility: 'everyone' }))),
      ).toBe('access.denied');
      const shared = await create.execute(
        as(productsModerator()),
        body({ visibility: 'everyone' }),
      );
      expect(shared.ok).toBe(true);
      expect(audits.map((entry) => entry.action)).toEqual(['lists.saved-filter.shared']);
    });

    it('does not take the share key of another list', async () => {
      const { create, as } = setup();
      const who = admin([ORDERS_VIEW, PRODUCTS_SHARE]);
      const result = await create.execute(
        as(who),
        body({ listKey: ORDERS, visibility: 'everyone' }),
      );
      expect(failure(result)).toBe('access.denied');
    });

    it('refuses a payload the list does not read, and unknown fields', async () => {
      const { create, as } = setup();
      const who = productsOnly();
      expect(failure(await create.execute(as(who), body({ payload: { v: 2 } })))).toBe(
        'validation.failed',
      );
      expect(failure(await create.execute(as(who), { ...body(), extra: 1 } as never))).toBe(
        'validation.failed',
      );
      expect(failure(await create.execute(as(who), body({ name: '  ' })))).toBe(
        'validation.failed',
      );
    });

    it('keeps a name one per owner and list, and the caps', async () => {
      const { create, as } = setup();
      const who = productsOnly();
      expect((await create.execute(as(who), body())).ok).toBe(true);
      expect(failure(await create.execute(as(who), body({ name: 'MEAT, ACTIVE' })))).toBe(
        'saved-filter.name-taken',
      );
      // The same name in another list is a different filter.
      const asOrders = admin([PRODUCTS_VIEW, ORDERS_VIEW]);
      expect((await create.execute(as(asOrders), body({ listKey: ORDERS }))).ok).toBe(true);

      const many = productsOnly();
      for (let index = 0; index < MAX_SAVED_FILTERS_PER_OWNER; index += 1) {
        expect((await create.execute(as(many), body({ name: `Filter ${index}` }))).ok).toBe(true);
      }
      const over = await create.execute(as(many), body({ name: 'One more' }));
      expect(over).toEqual(
        err({ code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER }),
      );
    });

    it('caps the filters shared with everyone in a list', async () => {
      const { create, as } = setup();
      for (let index = 0; index < MAX_SHARED_SAVED_FILTERS; index += 1) {
        const result = await create.execute(
          as(productsModerator()),
          body({ name: `Shared ${index}`, visibility: 'everyone' }),
        );
        expect(result.ok).toBe(true);
      }
      const over = await create.execute(
        as(productsModerator()),
        body({ name: 'Shared over', visibility: 'everyone' }),
      );
      expect(failure(over)).toBe('saved-filter.shared-limit-reached');
    });

    it('is refused for a caller who is not an admin', async () => {
      const { create } = setup();
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: ids.next<'Seller'>(),
        }),
      );
      expect(failure(await create.execute(seller, body()))).toBe('access.denied');
    });
  });

  describe('list', () => {
    it('shows the caller their own filters first, then the ones shared with everyone', async () => {
      const { create, list, as } = setup();
      const mine = productsOnly();
      const other = productsModerator();
      await create.execute(as(other), body({ name: 'Theirs shared', visibility: 'everyone' }));
      await create.execute(as(other), body({ name: 'Theirs private' }));
      await create.execute(as(mine), body({ name: 'Mine' }));

      const result = await list.execute(as(mine), { listKey: PRODUCTS });

      expect(result.ok && result.value.items.map((item) => item.name)).toEqual([
        'Mine',
        'Theirs shared',
      ]);
      expect(result.ok && result.value.canShare).toBe(false);
    });

    it('answers canShare for a moderator and nothing from another list', async () => {
      const { create, list, as } = setup();
      const who = admin([PRODUCTS_VIEW, PRODUCTS_SHARE, ORDERS_VIEW]);
      await create.execute(as(who), body());
      const orders = await list.execute(as(who), { listKey: ORDERS });
      expect(orders.ok && orders.value.items).toEqual([]);
      const products = await list.execute(as(who), { listKey: PRODUCTS });
      expect(products.ok && products.value.canShare).toBe(true);
    });

    it('leaves out a filter whose document the list no longer reads', async () => {
      const { create, list, as, store } = setup();
      const who = productsOnly();
      const created = await create.execute(as(who), body());
      const row = store.rows.get(created.ok ? created.value.id : '');
      if (row !== undefined) row.filter = { ...row.filter, payload: { v: 9 } };
      const result = await list.execute(as(who), { listKey: PRODUCTS });
      expect(result.ok && result.value.items).toEqual([]);
    });

    it('refuses without the view key and when the port cannot answer', async () => {
      const denied = setup();
      expect(failure(await denied.list.execute(denied.as(admin([])), { listKey: PRODUCTS }))).toBe(
        'access.denied',
      );
      const down = setup({ unavailable: true });
      expect(failure(await down.list.execute(down.as(productsOnly()), { listKey: PRODUCTS }))).toBe(
        'access.unavailable',
      );
    });

    it('does not show one Market the rows of another', async () => {
      const { create, list, as } = setup();
      const here = productsOnly();
      await create.execute(as(here), body());
      const there = admin([PRODUCTS_VIEW], otherMarket);
      const result = await list.execute(as(there), { listKey: PRODUCTS });
      expect(result.ok && result.value.items).toEqual([]);
    });
  });

  describe('update and delete', () => {
    async function shared() {
      const kit = setup();
      const owner = productsModerator();
      const made = await kit.create.execute(
        kit.as(owner),
        body({ name: 'Shared', visibility: 'everyone' }),
      );
      return { ...kit, owner, id: made.ok ? made.value.id : '' };
    }

    it('lets the owner rename, and audits a change to or from everyone', async () => {
      const { update, as, owner, id, audits } = await shared();
      const result = await update.execute(as(owner), {
        id,
        listKey: PRODUCTS,
        name: 'Renamed',
        visibility: 'me',
      });
      expect(result.ok && result.value).toMatchObject({ name: 'Renamed', visibility: 'me' });
      expect(audits.map((entry) => entry.action)).toEqual([
        'lists.saved-filter.shared',
        'lists.saved-filter.changed',
      ]);
    });

    it('lets a moderator of that list manage a shared filter, not an admin without the share key', async () => {
      const { update, remove, as, id } = await shared();
      const plain = productsOnly();
      expect(
        failure(
          await update.execute(as(plain), {
            id,
            listKey: PRODUCTS,
            name: 'Nope',
            visibility: 'everyone',
          }),
        ),
      ).toBe('access.denied');
      expect(failure(await remove.execute(as(plain), { id, listKey: PRODUCTS }))).toBe(
        'access.denied',
      );
      const moderator = productsModerator();
      expect((await remove.execute(as(moderator), { id, listKey: PRODUCTS })).ok).toBe(true);
    });

    it('answers not-found for a private filter of somebody else', async () => {
      const kit = setup();
      const owner = productsOnly();
      const made = await kit.create.execute(kit.as(owner), body());
      const id = made.ok ? made.value.id : '';
      const intruder = productsModerator();
      expect(failure(await kit.remove.execute(kit.as(intruder), { id, listKey: PRODUCTS }))).toBe(
        'saved-filter.not-found',
      );
    });

    it('never reaches a filter of another list through the named list', async () => {
      const kit = setup();
      const who = admin([PRODUCTS_VIEW, ORDERS_VIEW, ORDERS_SHARE]);
      const made = await kit.create.execute(
        kit.as(who),
        body({ listKey: ORDERS, name: 'Order view', visibility: 'everyone' }),
      );
      const id = made.ok ? made.value.id : '';
      const viaProducts = await kit.remove.execute(kit.as(who), { id, listKey: PRODUCTS });
      expect(failure(viaProducts)).toBe('saved-filter.not-found');
      expect(kit.store.rows.size).toBe(1);
    });

    it('needs the view key of the named list even for the owner', async () => {
      const kit = setup();
      const who = productsOnly();
      const made = await kit.create.execute(kit.as(who), body());
      const id = made.ok ? made.value.id : '';
      const revoked = admin([], market);
      kit.as({ ...revoked, accountId: who.accountId });
      expect(failure(await kit.remove.execute(revoked.context, { id, listKey: PRODUCTS }))).toBe(
        'access.denied',
      );
    });

    it('treats a text that is no id as not-found, and asks for the list', async () => {
      const kit = setup();
      const who = productsOnly();
      expect(failure(await kit.remove.execute(kit.as(who), { id: 'x', listKey: PRODUCTS }))).toBe(
        'saved-filter.not-found',
      );
      expect(failure(await kit.remove.execute(kit.as(who), { id: 'x' }))).toBe('validation.failed');
    });
  });

  describe('reorder', () => {
    async function three() {
      const kit = setup();
      const who = productsOnly();
      const created: string[] = [];
      for (const name of ['A', 'B', 'C']) {
        const made = await kit.create.execute(kit.as(who), body({ name }));
        if (made.ok) created.push(made.value.id);
      }
      return { ...kit, who, created };
    }

    it('puts the caller’s own filters in the order given', async () => {
      const { reorder, list, as, who, created } = await three();
      const [a, b, c] = created as [string, string, string];
      const result = await reorder.execute(as(who), { listKey: PRODUCTS, ids: [c, a, b] });
      expect(result.ok && result.value.ids).toEqual([c, a, b]);
      const read = await list.execute(as(who), { listKey: PRODUCTS });
      expect(read.ok && read.value.items.map((item) => item.name)).toEqual(['C', 'A', 'B']);
    });

    it('refuses a set that is not exactly the caller’s own filters', async () => {
      const { reorder, as, who, created } = await three();
      const [a, b] = created as [string, string];
      for (const ids of [[a, b], [a, a, b], [...created, created[0]], ['x']]) {
        expect(failure(await reorder.execute(as(who), { listKey: PRODUCTS, ids }))).toBe(
          'validation.failed',
        );
      }
    });

    it('does not move a filter of somebody else, shared or not', async () => {
      const { reorder, create, as, who, created } = await three();
      const other = productsModerator();
      const theirs = await create.execute(
        as(other),
        body({ name: 'Theirs', visibility: 'everyone' }),
      );
      const ids = [...created, theirs.ok ? theirs.value.id : ''];
      expect(failure(await reorder.execute(as(who), { listKey: PRODUCTS, ids }))).toBe(
        'validation.failed',
      );
    });

    it('needs the view key of the list', async () => {
      const kit = setup();
      expect(
        failure(await kit.reorder.execute(kit.as(admin([])), { listKey: PRODUCTS, ids: [] })),
      ).toBe('access.denied');
    });
  });

  describe('declarations', () => {
    it('every use case declares own-resources and asks the list keys at run time', () => {
      for (const useCase of [
        SavedFiltersList,
        SavedFilterCreate,
        SavedFilterUpdate,
        SavedFilterDelete,
        SavedFiltersReorder,
      ]) {
        expect(useCase.access.rule).toEqual({ kind: 'own-resources' });
        expect(useCase.access.whenSellerNotApproved).toBe('deny');
      }
    });
  });
});
