import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryOrderingSavedFilters } from '../../../../../test/support/ordering-saved-view-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_SAVED_FILTERS_PER_OWNER, MAX_SHARED_SAVED_FILTERS } from '../../domain/saved-view';
import { AdminSavedFilterCreate } from './admin-saved-filter-create.use-case';
import { AdminSavedFilterDelete } from './admin-saved-filter-delete.use-case';
import { AdminSavedFilterUpdate } from './admin-saved-filter-update.use-case';
import { AdminSavedFiltersList } from './admin-saved-filters-list.use-case';
import { SavedFilterShareCheck } from './saved-filter-share-check.use-case';
import { SellerSavedFilterCreate } from './seller-saved-filter-create.use-case';
import { SellerSavedFilterDelete } from './seller-saved-filter-delete.use-case';
import { SellerSavedFilterUpdate } from './seller-saved-filter-update.use-case';
import { SellerSavedFiltersList } from './seller-saved-filters-list.use-case';

// The saved-filter use cases of the order lists in memory, on both Market
// fixtures: the access rules (view key, share key, owner), the closed documents, the caps, the
// name uniques, the audit rows for filters shared with everyone, the seller list that is never
// shared, and that one Market never sees another's rows. The SQL behaviour is in
// test/db/ordering-saved-views.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
const ADMIN_LIST = 'admin.ordering.orders';
const SELLER_LIST = 'seller.ordering.orders';
const VIEW = 'ordering.order.view';
const SELLER_VIEW = 'ordering.seller-order.view';
const SHARE = 'ordering.saved-filter.share';
const PAYLOAD = {
  v: 1,
  tab: 'confirmed',
  filters: { paymentState: 'captured', from: '2026-11-01', to: '2026-11-05' },
  sort: 'total-high',
};
const SELLER_PAYLOAD = { v: 1, tab: 'to-ship', filters: { from: '2026-11-01' } };

describe.each(['AU', 'ZZ'] as const)('order list saved filters in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);

  const person = (
    population: 'admin' | 'seller',
    keys: readonly string[],
    inMarket: MarketContext = market,
  ) => {
    const accountId = ids.next<'Account'>();
    const context: CallContext = testCallContext(
      inMarket,
      testAuthenticatedActor(inMarket, {
        population,
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );
    return { accountId, context, keys };
  };
  const viewer = () => person('admin', [VIEW]);
  const moderator = () => person('admin', [VIEW, SHARE]);
  const seller = (inMarket?: MarketContext) => person('seller', [SELLER_VIEW], inMarket);

  function setup() {
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const actor = context.actor;
        const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const gate = createUseCaseGate(markets, check);
    const savedFilters = new MemoryOrderingSavedFilters();
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
    const base = { unitOfWork, savedFilters, audit, clock, ids };
    const adminDeps = { ...base, shareCheck: new SavedFilterShareCheck(gate) };
    const sellerDeps = { ...base, shareCheck: null };
    return {
      savedFilters,
      audits,
      admin: {
        list: new AdminSavedFiltersList(gate, adminDeps),
        create: new AdminSavedFilterCreate(gate, adminDeps),
        update: new AdminSavedFilterUpdate(gate, adminDeps),
        remove: new AdminSavedFilterDelete(gate, adminDeps),
      },
      seller: {
        list: new SellerSavedFiltersList(gate, sellerDeps),
        create: new SellerSavedFilterCreate(gate, sellerDeps),
        update: new SellerSavedFilterUpdate(gate, sellerDeps),
        remove: new SellerSavedFilterDelete(gate, sellerDeps),
      },
      as(who: ReturnType<typeof person>) {
        held.set(who.accountId, who.keys);
        return who.context;
      },
    };
  }

  const body = (overrides: Record<string, unknown> = {}) => ({
    listKey: ADMIN_LIST,
    name: 'Paid last week',
    visibility: 'me',
    payload: PAYLOAD,
    ...overrides,
  });
  const failure = (result: Result<unknown, { code: string }>) =>
    result.ok ? 'ok' : result.error.code;

  it('declares the view key on every use case and the share key on the share check', () => {
    for (const useCase of [
      AdminSavedFiltersList,
      AdminSavedFilterCreate,
      AdminSavedFilterUpdate,
      AdminSavedFilterDelete,
    ]) {
      expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
    }
    for (const useCase of [
      SellerSavedFiltersList,
      SellerSavedFilterCreate,
      SellerSavedFilterUpdate,
      SellerSavedFilterDelete,
    ]) {
      expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [SELLER_VIEW] });
      expect(useCase.access.whenSellerNotApproved).toBe('deny');
    }
    expect(SavedFilterShareCheck.access.rule).toEqual({ kind: 'permissions', allOf: [SHARE] });
  });

  describe('admin saved filters', () => {
    it('saves a private filter in canonical form without an audit row', async () => {
      const s = setup();
      const me = viewer();

      const result = await s.admin.create.execute(s.as(me), body({ name: '  Paid last week ' }));

      expect(result).toMatchObject({
        ok: true,
        value: {
          listKey: ADMIN_LIST,
          name: 'Paid last week',
          visibility: 'me',
          ownedByMe: true,
          canManage: true,
          payload: PAYLOAD,
        },
      });
      expect([...s.savedFilters.rows.values()][0]).toMatchObject({
        marketId: market.marketId,
        ownerAccountId: me.accountId,
        position: 1,
      });
      expect(s.audits).toEqual([]);
    });

    it('stores the document in canonical form: the newest sort and empty parts are left out', async () => {
      const s = setup();

      const result = await s.admin.create.execute(
        s.as(viewer()),
        body({
          payload: {
            v: 1,
            tab: 'all',
            filters: { paymentState: '', from: '2026-11-01' },
            sort: 'newest',
          },
        }),
      );

      expect(result).toMatchObject({
        ok: true,
        value: {
          payload: { v: 1, tab: 'all', filters: { from: '2026-11-01' } },
        },
      });
    });

    it('refuses "everyone" without the share key and writes nothing', async () => {
      const s = setup();

      const result = await s.admin.create.execute(s.as(viewer()), body({ visibility: 'everyone' }));

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(s.savedFilters.rows.size).toBe(0);
    });

    it('saves for everyone with the share key and audits ids and codes only', async () => {
      const s = setup();

      const result = await s.admin.create.execute(
        s.as(moderator()),
        body({ visibility: 'everyone' }),
      );

      expect(result).toMatchObject({ ok: true, value: { visibility: 'everyone' } });
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        action: 'ordering.saved-filter.shared',
        targetType: 'ordering.saved-filter',
        after: { listKey: ADMIN_LIST, visibility: 'everyone' },
      });
      expect(JSON.stringify(s.audits[0])).not.toContain('Paid last week');
    });

    it.each([
      ['an unknown tab', { payload: { ...PAYLOAD, tab: 'refunded' } }, 'payload.tab'],
      ['an unknown key', { payload: { ...PAYLOAD, q: 'x' } }, 'payload.q'],
      [
        'a payment state that does not exist',
        { payload: { ...PAYLOAD, filters: { paymentState: 'paid' } } },
        'payload.filters.paymentState',
      ],
      [
        'a day that is not a day',
        { payload: { ...PAYLOAD, filters: { from: '2026-13-40' } } },
        'payload.filters.from',
      ],
      [
        'days the wrong way round',
        { payload: { ...PAYLOAD, filters: { from: '2026-11-05', to: '2026-11-01' } } },
        'payload.filters.to',
      ],
      ['a name with a control character', { name: 'a\u0007b' }, 'name'],
      ['the seller list key', { listKey: SELLER_LIST }, 'listKey'],
      ['an unknown body key', { extra: 1 }, 'extra'],
    ])('refuses %s', async (_label, overrides, path) => {
      const s = setup();

      const result = await s.admin.create.execute(s.as(viewer()), body(overrides));

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path }] },
      });
      expect(s.savedFilters.rows.size).toBe(0);
    });

    it('keeps one name per owner and one among shared filters, whatever the case', async () => {
      const s = setup();
      const me = viewer();
      const other = moderator();
      await s.admin.create.execute(s.as(me), body());

      expect(
        failure(await s.admin.create.execute(s.as(me), body({ name: 'PAID LAST WEEK' }))),
      ).toBe('saved-filter.name-taken');
      expect(failure(await s.admin.create.execute(s.as(other), body()))).toBe('ok');
      await s.admin.create.execute(s.as(me), body({ name: 'Shared', visibility: 'me' }));
      await s.admin.create.execute(s.as(other), body({ name: 'Shared', visibility: 'everyone' }));
      expect(
        failure(
          await s.admin.create.execute(
            s.as(moderator()),
            body({ name: 'shared', visibility: 'everyone' }),
          ),
        ),
      ).toBe('saved-filter.name-taken');
    });

    it('stops at the cap per owner and the cap of shared filters', async () => {
      const s = setup();
      const me = moderator();
      for (let i = 0; i < MAX_SHARED_SAVED_FILTERS; i += 1) {
        await s.admin.create.execute(
          s.as(me),
          body({ name: `Shared ${i}`, visibility: 'everyone' }),
        );
      }
      expect(
        await s.admin.create.execute(
          s.as(me),
          body({ name: 'One too many', visibility: 'everyone' }),
        ),
      ).toEqual({
        ok: false,
        error: { code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS },
      });
      for (let i = MAX_SHARED_SAVED_FILTERS; i < MAX_SAVED_FILTERS_PER_OWNER; i += 1) {
        await s.admin.create.execute(s.as(me), body({ name: `Mine ${i}` }));
      }
      expect(await s.admin.create.execute(s.as(me), body({ name: 'Over' }))).toEqual({
        ok: false,
        error: { code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER },
      });
    });

    it('lists the caller’s own filters first, then the shared ones, and never another private one', async () => {
      const s = setup();
      const me = viewer();
      const other = moderator();
      await s.admin.create.execute(s.as(other), body({ name: 'Theirs, private' }));
      await s.admin.create.execute(
        s.as(other),
        body({ name: 'Theirs, shared', visibility: 'everyone' }),
      );
      await s.admin.create.execute(s.as(me), body({ name: 'Mine' }));

      const listed = await s.admin.list.execute(s.as(me), { listKey: ADMIN_LIST });

      expect(listed).toMatchObject({ ok: true, value: { canShare: false } });
      if (!listed.ok) return;
      expect(listed.value.items.map((item) => [item.name, item.ownedByMe, item.canManage])).toEqual(
        [
          ['Mine', true, true],
          ['Theirs, shared', false, false],
        ],
      );
      expect(listed.value.limits).toEqual({
        perOwner: MAX_SAVED_FILTERS_PER_OWNER,
        shared: MAX_SHARED_SAVED_FILTERS,
      });
    });

    it('leaves out a stored document that no longer reads as the list’s vocabulary', async () => {
      const s = setup();
      const me = viewer();
      await s.admin.create.execute(s.as(me), body());
      const [stored] = [...s.savedFilters.rows.values()];
      s.savedFilters.rows.set(`${market.marketId}/${stored!.id}`, {
        ...stored!,
        payload: { v: 1, tab: 'gone' },
      });

      const listed = await s.admin.list.execute(s.as(me), { listKey: ADMIN_LIST });

      expect(listed).toMatchObject({ ok: true, value: { items: [] } });
    });

    it('lets the owner rename and delete, and refuses somebody else’s private filter as not found', async () => {
      const s = setup();
      const me = viewer();
      const other = viewer();
      const created = await s.admin.create.execute(s.as(me), body());
      if (!created.ok) throw new Error('setup');
      const id = created.value.id;

      expect(
        failure(await s.admin.update.execute(s.as(other), { id, name: 'x', visibility: 'me' })),
      ).toBe('saved-filter.not-found');
      expect(failure(await s.admin.remove.execute(s.as(other), { id }))).toBe(
        'saved-filter.not-found',
      );
      expect(
        await s.admin.update.execute(s.as(me), { id, name: 'Renamed', visibility: 'me' }),
      ).toMatchObject({ ok: true, value: { name: 'Renamed' } });
      expect(await s.admin.remove.execute(s.as(me), { id })).toEqual({ ok: true, value: { id } });
      expect(failure(await s.admin.remove.execute(s.as(me), { id }))).toBe(
        'saved-filter.not-found',
      );
    });

    it('lets a sharer manage a shared filter of somebody else, and audits every change of it', async () => {
      const s = setup();
      const owner = moderator();
      const sharer = moderator();
      const plain = viewer();
      const created = await s.admin.create.execute(s.as(owner), body({ visibility: 'everyone' }));
      if (!created.ok) throw new Error('setup');
      const id = created.value.id;

      expect(failure(await s.admin.remove.execute(s.as(plain), { id }))).toBe('access.denied');
      expect(
        await s.admin.update.execute(s.as(sharer), {
          id,
          name: 'Team view',
          visibility: 'everyone',
        }),
      ).toMatchObject({ ok: true, value: { name: 'Team view', canManage: true } });
      expect(await s.admin.remove.execute(s.as(sharer), { id })).toEqual({
        ok: true,
        value: { id },
      });
      expect(s.audits.map((entry) => entry.action)).toEqual([
        'ordering.saved-filter.shared',
        'ordering.saved-filter.changed',
        'ordering.saved-filter.removed',
      ]);
      expect(s.audits[1]).toMatchObject({ after: { renamed: true, ownedByActor: false } });
    });

    it('needs the share key to move a filter to everyone', async () => {
      const s = setup();
      const me = viewer();
      const created = await s.admin.create.execute(s.as(me), body());
      if (!created.ok) throw new Error('setup');

      expect(
        failure(
          await s.admin.update.execute(s.as(me), {
            id: created.value.id,
            name: 'Paid last week',
            visibility: 'everyone',
          }),
        ),
      ).toBe('access.denied');
    });

    it('never sees another Market’s rows', async () => {
      const s = setup();
      const here = viewer();
      const there = person('admin', [VIEW], otherMarket);
      await s.admin.create.execute(s.as(there), body());

      const listed = await s.admin.list.execute(s.as(here), { listKey: ADMIN_LIST });

      expect(listed).toMatchObject({ ok: true, value: { items: [] } });
    });

    it('answers access.denied to a seller on the admin use cases', async () => {
      const s = setup();

      expect(failure(await s.admin.list.execute(s.as(seller()), { listKey: ADMIN_LIST }))).toBe(
        'access.denied',
      );
    });
  });

  describe('seller saved filters', () => {
    const sellerBody = (overrides: Record<string, unknown> = {}) => ({
      listKey: SELLER_LIST,
      name: 'Waiting to ship',
      payload: SELLER_PAYLOAD,
      ...overrides,
    });

    it('saves a private filter without a visibility and never shares it', async () => {
      const s = setup();
      const me = seller();

      expect(await s.seller.create.execute(s.as(me), sellerBody())).toMatchObject({
        ok: true,
        value: { visibility: 'me', ownedByMe: true, payload: SELLER_PAYLOAD },
      });
      expect(
        failure(
          await s.seller.create.execute(
            s.as(me),
            sellerBody({ name: 'B', visibility: 'everyone' }),
          ),
        ),
      ).toBe('validation.failed');
      expect(s.audits).toEqual([]);
    });

    it('refuses the admin list key and admin-only filters', async () => {
      const s = setup();
      const me = seller();

      expect(
        failure(await s.seller.create.execute(s.as(me), sellerBody({ listKey: ADMIN_LIST }))),
      ).toBe('validation.failed');
      expect(
        failure(
          await s.seller.create.execute(
            s.as(me),
            sellerBody({ payload: { v: 1, tab: 'all', filters: { paymentState: 'captured' } } }),
          ),
        ),
      ).toBe('validation.failed');
      expect(
        failure(
          await s.seller.create.execute(
            s.as(me),
            sellerBody({ payload: { v: 1, tab: 'confirmed' } }),
          ),
        ),
      ).toBe('validation.failed');
    });

    it('lists only the caller’s own filters and keeps another seller’s out of reach', async () => {
      const s = setup();
      const me = seller();
      const other = seller();
      const theirs = await s.seller.create.execute(s.as(other), sellerBody());
      await s.seller.create.execute(s.as(me), sellerBody({ name: 'Mine' }));
      if (!theirs.ok) throw new Error('setup');

      const listed = await s.seller.list.execute(s.as(me), { listKey: SELLER_LIST });

      expect(listed).toMatchObject({ ok: true, value: { canShare: false } });
      if (!listed.ok) return;
      expect(listed.value.items.map((item) => item.name)).toEqual(['Mine']);
      expect(
        failure(await s.seller.update.execute(s.as(me), { id: theirs.value.id, name: 'x' })),
      ).toBe('saved-filter.not-found');
      expect(failure(await s.seller.remove.execute(s.as(me), { id: theirs.value.id }))).toBe(
        'saved-filter.not-found',
      );
    });

    it('renames and deletes its own, and a seller cannot reach an admin filter', async () => {
      const s = setup();
      const me = seller();
      const created = await s.seller.create.execute(s.as(me), sellerBody());
      const adminFilter = await s.admin.create.execute(
        s.as(moderator()),
        body({ visibility: 'everyone' }),
      );
      if (!created.ok || !adminFilter.ok) throw new Error('setup');

      expect(
        await s.seller.update.execute(s.as(me), { id: created.value.id, name: 'New' }),
      ).toMatchObject({
        ok: true,
        value: { name: 'New' },
      });
      expect(failure(await s.seller.remove.execute(s.as(me), { id: adminFilter.value.id }))).toBe(
        'saved-filter.not-found',
      );
      expect(await s.seller.remove.execute(s.as(me), { id: created.value.id })).toEqual({
        ok: true,
        value: { id: created.value.id },
      });
    });

    it('answers access.denied to an admin on the seller use cases', async () => {
      const s = setup();

      expect(failure(await s.seller.list.execute(s.as(viewer()), { listKey: SELLER_LIST }))).toBe(
        'access.denied',
      );
    });
  });
});
