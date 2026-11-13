import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemorySellerSavedFilters } from '../../../../../test/support/saved-filter-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_SAVED_FILTERS_PER_OWNER, MAX_SHARED_SAVED_FILTERS } from '../../domain/saved-filter';
import { OwnSavedFilterCreate } from './own-saved-filter-create.use-case';
import { OwnSavedFilterDelete } from './own-saved-filter-delete.use-case';
import { OwnSavedFilterShareCheck } from './own-saved-filter-share-check.use-case';
import { OwnSavedFilterUpdate } from './own-saved-filter-update.use-case';
import { OwnSavedFiltersList } from './own-saved-filters-list.use-case';

// The seller saved-filter use cases in memory (catalog design 9.2d), on both Market fixtures: the
// access rules (view key, share key, owner), the closed document of the seller list, the caps, the
// name uniques, the audit rows for filters shared with the store, the Login-as-Seller refusal and,
// above all, that one store never sees or changes another store's filters. The SQL behaviour is in
// test/db/catalog-seller-saved-filters.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const LIST = 'seller.catalog.products';
const VIEW = 'catalog.own-product.view';
const SHARE = 'catalog.own-saved-filter.share';
const PAYLOAD = {
  v: 1,
  view: 'live',
  q: 'dates',
  status: 'published',
  paused: false,
  sort: 'name',
  direction: 'asc',
};

describe.each(['AU', 'ZZ'] as const)('seller saved filters in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const STORE_A = ids.next<'Seller'>();
  const STORE_B = ids.next<'Seller'>();

  /** A member of a store with the keys given; the gate admits a use case when they hold its keys. */
  const member = (
    keys: readonly string[],
    sellerId = STORE_A,
    inMarket: MarketContext = market,
  ) => {
    const accountId = ids.next<'Account'>();
    const context: CallContext = testCallContext(
      inMarket,
      testAuthenticatedActor(inMarket, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
    return { accountId, context, keys };
  };
  const viewer = (sellerId = STORE_A) => member([VIEW], sellerId);
  const owner = (sellerId = STORE_A) => member([VIEW, SHARE], sellerId);

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
    const repo = new MemorySellerSavedFilters();
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_context, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
    const unitOfWork = {
      run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
        units.push({ market: m.marketId, options: o });
        return work();
      },
    } as unknown as UnitOfWork;
    const ownShareCheck = new OwnSavedFilterShareCheck(gate);
    const base = { unitOfWork, sellerSavedFilters: repo, ownShareCheck };
    return {
      repo,
      audits,
      units,
      create: new OwnSavedFilterCreate(gate, { ...base, audit, clock, ids }),
      update: new OwnSavedFilterUpdate(gate, { ...base, audit, clock }),
      remove: new OwnSavedFilterDelete(gate, { ...base, audit }),
      list: new OwnSavedFiltersList(gate, base),
      as(who: ReturnType<typeof member>) {
        held.set(who.accountId, who.keys);
        return who.context;
      },
    };
  }

  const body = (overrides: Record<string, unknown> = {}) => ({
    listKey: LIST,
    name: 'Live dates',
    visibility: 'me',
    payload: PAYLOAD,
    ...overrides,
  });
  const failure = (result: Result<unknown, { code: string }>) =>
    result.ok ? 'ok' : result.error.code;
  const idOf = (result: unknown) => (result as { value: { id: string } }).value.id;
  const namesOf = (result: unknown) =>
    (result as { value: { items: { name: string }[] } }).value.items.map((i) => i.name);

  describe('declarations', () => {
    it('each use case declares the seller view key; the share check declares the share key', () => {
      for (const useCase of [
        OwnSavedFiltersList,
        OwnSavedFilterCreate,
        OwnSavedFilterUpdate,
        OwnSavedFilterDelete,
      ]) {
        expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
      }
      expect(OwnSavedFilterShareCheck.access.rule).toEqual({
        kind: 'permissions',
        allOf: [SHARE],
      });
    });
  });

  describe('create', () => {
    it('saves a private filter for a view-only member, in canonical form, in the member’s store', async () => {
      const s = setup();
      const me = viewer();

      const result = await s.create.execute(s.as(me), body({ name: '  Live dates ' }));

      expect(result).toMatchObject({
        ok: true,
        value: {
          listKey: LIST,
          name: 'Live dates',
          visibility: 'me',
          ownedByMe: true,
          canManage: true,
          payload: { v: 1, view: 'live', q: 'dates', status: 'published', paused: false },
        },
      });
      expect([...s.repo.rows.values()]).toHaveLength(1);
      expect([...s.repo.rows.values()][0]).toMatchObject({
        marketId: market.marketId,
        ownerAccountId: me.accountId,
        sellerId: STORE_A,
        position: 1,
      });
      expect(s.audits).toEqual([]);
      expect(s.units).toEqual([
        { market: market.marketId, options: { isolation: 'serializable' } },
      ]);
    });

    it('fills the tab, sort and direction the way the list does', async () => {
      const s = setup();

      const result = await s.create.execute(s.as(viewer()), body({ payload: { v: 1 } }));

      expect(result).toMatchObject({
        ok: true,
        value: { payload: { v: 1, view: 'all', sort: 'updated', direction: 'desc' } },
      });
    });

    it('takes the store from the actor: a sellerId in the body is an unknown key', async () => {
      const s = setup();

      const result = await s.create.execute(s.as(viewer()), body({ sellerId: STORE_B }));

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sellerId', code: 'unknown' }] },
      });
      expect(s.repo.rows.size).toBe(0);
    });

    it('refuses "everyone" without the share key and writes nothing', async () => {
      const s = setup();

      const result = await s.create.execute(s.as(viewer()), body({ visibility: 'everyone' }));

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(s.repo.rows.size).toBe(0);
      expect(s.units).toEqual([]);
    });

    it('saves a filter for the store with the share key and audits it (ids and codes, no name)', async () => {
      const s = setup();

      const result = await s.create.execute(s.as(owner()), body({ visibility: 'everyone' }));

      expect(result).toMatchObject({ ok: true, value: { visibility: 'everyone' } });
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        action: 'catalog.saved-filter.shared',
        targetType: 'catalog.saved-filter',
        after: { listKey: LIST, visibility: 'everyone' },
      });
      expect(JSON.stringify(s.audits)).not.toContain('Live dates');
    });

    it('refuses an admin session, an anonymous call and a member without the view key', async () => {
      const s = setup();
      const admin = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      const blind = member([]);

      expect(failure(await s.create.execute(admin, body()))).toBe('access.denied');
      expect(failure(await s.create.execute(s.as(blind), body()))).toBe('access.denied');
      expect(s.repo.rows.size).toBe(0);
    });

    it.each([
      ['an admin list', { listKey: 'admin.catalog.products' }, 'listKey'],
      ['an unknown list', { listKey: 'seller.orders' }, 'listKey'],
      ['the plan’s dashed name', { listKey: 'seller-products' }, 'listKey'],
      ['no list', { listKey: undefined }, 'listKey'],
      ['an empty name', { name: '   ' }, 'name'],
      ['a name of 61 characters', { name: 'x'.repeat(61) }, 'name'],
      ['a name with a control character', { name: 'a\u0007b' }, 'name'],
      ['a name that is not text', { name: 5 }, 'name'],
      ['another visibility', { visibility: 'team' }, 'visibility'],
      ['an unknown key in the body', { extra: 1 }, 'extra'],
      ['a page in the payload', { payload: { ...PAYLOAD, page: 2 } }, 'payload.page'],
      ['a nested filters key', { payload: { ...PAYLOAD, filters: {} } }, 'payload.filters'],
      ['a payload of another version', { payload: { ...PAYLOAD, v: 2 } }, 'payload.v'],
      ['a tab that does not exist', { payload: { ...PAYLOAD, view: 'archived' } }, 'payload.view'],
      [
        'a status the list never shows',
        { payload: { ...PAYLOAD, status: 'withdrawn' } },
        'payload.status',
      ],
      ['a sort that does not exist', { payload: { ...PAYLOAD, sort: 'price' } }, 'payload.sort'],
      [
        'a category that is no id',
        { payload: { ...PAYLOAD, categoryId: 'meat' } },
        'payload.categoryId',
      ],
      ['a paused that is no boolean', { payload: { ...PAYLOAD, paused: 'no' } }, 'payload.paused'],
      ['a search of 101 characters', { payload: { ...PAYLOAD, q: 'x'.repeat(101) } }, 'payload.q'],
      ['a payload that is not an object', { payload: 'view=all' }, 'payload'],
    ])('refuses %s as validation.failed naming the field', async (_label, overrides, path) => {
      const s = setup();

      const result = await s.create.execute(s.as(viewer()), body(overrides));

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path, code: expect.any(String) as string }],
        },
      });
      expect(s.repo.rows.size).toBe(0);
    });

    it('keeps one name per member and list whatever its case, but lets two members keep the same private name', async () => {
      const s = setup();
      const a = viewer();
      const b = viewer();
      await s.create.execute(s.as(a), body());

      expect(failure(await s.create.execute(s.as(a), body({ name: 'LIVE DATES' })))).toBe(
        'saved-filter.name-taken',
      );
      expect(failure(await s.create.execute(s.as(b), body()))).toBe('ok');
    });

    it('keeps one name among the filters a store shares, but another store may reuse it', async () => {
      const s = setup();
      await s.create.execute(s.as(owner()), body({ visibility: 'everyone' }));

      expect(
        failure(
          await s.create.execute(
            s.as(owner()),
            body({ visibility: 'everyone', name: 'live DATES' }),
          ),
        ),
      ).toBe('saved-filter.name-taken');
      expect(
        failure(await s.create.execute(s.as(owner(STORE_B)), body({ visibility: 'everyone' }))),
      ).toBe('ok');
    });

    it(`stops at ${MAX_SAVED_FILTERS_PER_OWNER} filters per member and list`, async () => {
      const s = setup();
      const me = viewer();
      const context = s.as(me);
      for (let n = 1; n <= MAX_SAVED_FILTERS_PER_OWNER; n++) {
        expect(failure(await s.create.execute(context, body({ name: `Filter ${n}` })))).toBe('ok');
      }

      const result = await s.create.execute(context, body({ name: 'One more' }));

      expect(result).toEqual({
        ok: false,
        error: { code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER },
      });
      expect(failure(await s.create.execute(s.as(viewer()), body()))).toBe('ok');
    });

    it(`stops at ${MAX_SHARED_SAVED_FILTERS} filters shared in a store, but a private one and another store still save`, async () => {
      const s = setup();
      for (let n = 1; n <= MAX_SHARED_SAVED_FILTERS; n++) {
        await s.create.execute(
          s.as(owner()),
          body({ visibility: 'everyone', name: `Shared ${n}` }),
        );
      }

      const shared = await s.create.execute(
        s.as(owner()),
        body({ visibility: 'everyone', name: 'Shared more' }),
      );

      expect(shared).toEqual({
        ok: false,
        error: { code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS },
      });
      expect(failure(await s.create.execute(s.as(owner()), body({ name: 'Private' })))).toBe('ok');
      expect(
        failure(
          await s.create.execute(
            s.as(owner(STORE_B)),
            body({ visibility: 'everyone', name: 'Shared more' }),
          ),
        ),
      ).toBe('ok');
    });
  });

  describe('list', () => {
    it('shows the caller their own filters first, then the store’s shared ones, and never a colleague’s private one', async () => {
      const s = setup();
      const me = viewer();
      const sam = owner();
      await s.create.execute(s.as(sam), body({ name: 'Sam private' }));
      await s.create.execute(s.as(sam), body({ name: 'Sam shared', visibility: 'everyone' }));
      await s.create.execute(s.as(me), body({ name: 'Mine' }));

      const result = await s.list.execute(s.as(me), { listKey: LIST });

      expect(result).toMatchObject({
        ok: true,
        value: {
          canShare: false,
          limits: { perOwner: MAX_SAVED_FILTERS_PER_OWNER, shared: MAX_SHARED_SAVED_FILTERS },
        },
      });
      const items = (result as unknown as { value: { items: Record<string, unknown>[] } }).value
        .items;
      expect(items.map((i) => [i['name'], i['ownedByMe'], i['canManage']])).toEqual([
        ['Mine', true, true],
        ['Sam shared', false, false],
      ]);
      expect(s.units).toContainEqual({ market: market.marketId, options: { readOnly: true } });
    });

    it('never shows another store’s filters, private or shared', async () => {
      const s = setup();
      const there = owner(STORE_B);
      await s.create.execute(s.as(there), body({ name: 'B private' }));
      await s.create.execute(s.as(there), body({ name: 'B shared', visibility: 'everyone' }));
      await s.create.execute(s.as(owner()), body({ name: 'A shared', visibility: 'everyone' }));

      const a = await s.list.execute(s.as(viewer()), { listKey: LIST });
      const b = await s.list.execute(s.as(viewer(STORE_B)), { listKey: LIST });

      expect(namesOf(a)).toEqual(['A shared']);
      expect(namesOf(b)).toEqual(['B shared']);
    });

    it('does not list admin filters, even in the same Market', async () => {
      const s = setup();
      const me = viewer();
      s.repo.rows.set(`${market.marketId}/admin-row`, {
        id: ids.next<'SavedFilter'>(),
        listKey: 'admin.catalog.products',
        ownerAccountId: me.accountId,
        sellerId: null,
        visibility: 'everyone',
        name: 'Admin shared',
        payload: PAYLOAD,
        position: 1,
        createdAt: T0,
        updatedAt: T0,
        marketId: market.marketId,
      });

      expect(namesOf(await s.list.execute(s.as(me), { listKey: LIST }))).toEqual([]);
    });

    it('tells a holder of the share key they can manage a shared filter of a colleague', async () => {
      const s = setup();
      await s.create.execute(s.as(owner()), body({ name: 'Sam shared', visibility: 'everyone' }));

      const result = await s.list.execute(s.as(owner()), { listKey: LIST });

      expect(result).toMatchObject({
        ok: true,
        value: {
          canShare: true,
          items: [{ name: 'Sam shared', ownedByMe: false, canManage: true }],
        },
      });
    });

    it('leaves out a stored document that no longer reads as the list’s vocabulary', async () => {
      const s = setup();
      const me = viewer();
      await s.create.execute(s.as(me), body({ name: 'Good' }));
      await s.create.execute(s.as(me), body({ name: 'Old' }));
      const old = [...s.repo.rows.values()].find((r) => r.name === 'Old')!;
      s.repo.rows.set(`${market.marketId}/${old.id}`, { ...old, payload: { v: 9 } });

      expect(namesOf(await s.list.execute(s.as(me), { listKey: LIST }))).toEqual(['Good']);
    });

    it('is closed: an unknown query key, an admin list or no list is validation.failed', async () => {
      const s = setup();
      const me = s.as(viewer());

      expect(await s.list.execute(me, { listKey: LIST, page: 2 } as never)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page', code: 'unknown' }] },
      });
      expect(failure(await s.list.execute(me, {}))).toBe('validation.failed');
      expect(failure(await s.list.execute(me, { listKey: 'admin.catalog.products' }))).toBe(
        'validation.failed',
      );
    });

    it('never shows another Market’s filters', async () => {
      const s = setup();
      const there = member([VIEW, SHARE], STORE_A, otherMarket);
      await s.create.execute(s.as(there), body({ name: 'Elsewhere', visibility: 'everyone' }));

      const result = await s.list.execute(s.as(owner()), { listKey: LIST });

      expect(result).toMatchObject({ ok: true, value: { items: [] } });
      expect([...s.repo.rows.values()][0]!.marketId).toBe(otherMarket.marketId);
    });
  });

  describe('update', () => {
    async function withFilter(visibility: 'me' | 'everyone', who = owner()) {
      const s = setup();
      const created = await s.create.execute(s.as(who), body({ visibility }));
      s.audits.length = 0;
      return { s, who, id: idOf(created) };
    }

    it('lets the owner rename a private filter, whatever the case of the new name', async () => {
      const { s, who, id } = await withFilter('me');

      const result = await s.update.execute(s.as(who), {
        id,
        name: 'live DATES',
        visibility: 'me',
      });

      expect(result).toMatchObject({ ok: true, value: { name: 'live DATES', visibility: 'me' } });
      expect(s.audits).toEqual([]);
    });

    it('shares a private filter only with the share key, and audits the change', async () => {
      const { s, who, id } = await withFilter('me');
      const plain = viewer();
      const plainId = idOf(await s.create.execute(s.as(plain), body({ name: 'Plain' })));

      expect(
        failure(
          await s.update.execute(s.as(plain), {
            id: plainId,
            name: 'Plain',
            visibility: 'everyone',
          }),
        ),
      ).toBe('access.denied');
      expect(
        await s.update.execute(s.as(who), { id, name: 'Live dates', visibility: 'everyone' }),
      ).toMatchObject({ ok: true, value: { visibility: 'everyone' } });
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        action: 'catalog.saved-filter.changed',
        before: { visibility: 'me' },
        after: { listKey: LIST, visibility: 'everyone', renamed: false, ownedByActor: true },
      });
    });

    it('lets the owner unshare and rename their shared filter even after losing the share key', async () => {
      const { s, who, id } = await withFilter('everyone');
      const demoted = { ...who, keys: [VIEW] };

      const renamed = await s.update.execute(s.as(demoted), {
        id,
        name: 'Renamed',
        visibility: 'everyone',
      });
      const unshared = await s.update.execute(s.as(demoted), {
        id,
        name: 'Renamed',
        visibility: 'me',
      });

      expect(renamed).toMatchObject({ ok: true, value: { name: 'Renamed', canManage: true } });
      expect(unshared).toMatchObject({ ok: true, value: { visibility: 'me' } });
      expect(s.audits.map((a) => a.action)).toEqual([
        'catalog.saved-filter.changed',
        'catalog.saved-filter.changed',
      ]);
    });

    it('lets a colleague with the share key change a shared filter, and says so in the audit row', async () => {
      const { s, id } = await withFilter('everyone');

      const result = await s.update.execute(s.as(owner()), {
        id,
        name: 'Their rename',
        visibility: 'everyone',
      });

      expect(result).toMatchObject({ ok: true, value: { name: 'Their rename', ownedByMe: false } });
      expect(s.audits[0]).toMatchObject({ after: { renamed: true, ownedByActor: false } });
    });

    it('refuses a colleague without the share key on a shared filter: access.denied', async () => {
      const { s, id } = await withFilter('everyone');

      const result = await s.update.execute(s.as(viewer()), {
        id,
        name: 'Mine now',
        visibility: 'everyone',
      });

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect([...s.repo.rows.values()][0]!.name).toBe('Live dates');
    });

    it('answers not-found for a colleague’s private filter, an unknown id and a malformed id alike', async () => {
      const { s, id } = await withFilter('me');
      const colleague = s.as(owner());

      for (const target of [id, ids.next<'SavedFilter'>(), 'not-an-id']) {
        expect(
          await s.update.execute(colleague, { id: target, name: 'X', visibility: 'me' }),
        ).toEqual({ ok: false, error: { code: 'saved-filter.not-found' } });
      }
    });

    it('answers not-found for another store’s filter, shared or not, even with the share key', async () => {
      const s = setup();
      const there = owner(STORE_B);
      const mine = idOf(await s.create.execute(s.as(there), body({ name: 'B private' })));
      const shared = idOf(
        await s.create.execute(s.as(there), body({ name: 'B shared', visibility: 'everyone' })),
      );
      s.audits.length = 0;

      for (const id of [mine, shared]) {
        expect(
          await s.update.execute(s.as(owner()), { id, name: 'Hijacked', visibility: 'everyone' }),
        ).toEqual({ ok: false, error: { code: 'saved-filter.not-found' } });
      }
      expect([...s.repo.rows.values()].map((r) => r.name).sort()).toEqual([
        'B private',
        'B shared',
      ]);
      expect(s.audits).toEqual([]);
    });

    it('answers name-taken for a name the owner already uses and writes nothing', async () => {
      const { s, who, id } = await withFilter('me');
      await s.create.execute(s.as(who), body({ name: 'Other' }));

      const result = await s.update.execute(s.as(who), { id, name: 'other', visibility: 'me' });

      expect(result).toEqual({ ok: false, error: { code: 'saved-filter.name-taken' } });
    });

    it('writes nothing when the name and visibility are the same', async () => {
      const { s, who, id } = await withFilter('everyone');
      const before = [...s.repo.rows.values()][0]!.updatedAt;
      clock.advance(Temporal.Duration.from({ seconds: 1 }));

      const result = await s.update.execute(s.as(who), {
        id,
        name: 'Live dates',
        visibility: 'everyone',
      });

      expect(result).toMatchObject({ ok: true });
      expect([...s.repo.rows.values()][0]!.updatedAt).toEqual(before);
      expect(s.audits).toEqual([]);
    });

    it('is closed and complete: both fields are needed and nothing else is read', async () => {
      const { s, who, id } = await withFilter('me');
      const context = s.as(who);

      expect(failure(await s.update.execute(context, { id, name: 'X' }))).toBe('validation.failed');
      expect(failure(await s.update.execute(context, { id, visibility: 'me' }))).toBe(
        'validation.failed',
      );
      expect(
        failure(
          await s.update.execute(context, {
            id,
            name: 'X',
            visibility: 'me',
            payload: PAYLOAD,
          } as never),
        ),
      ).toBe('validation.failed');
    });

    it('respects the shared cap when a filter is shared later', async () => {
      const s = setup();
      const who = owner();
      for (let n = 1; n <= MAX_SHARED_SAVED_FILTERS; n++) {
        await s.create.execute(s.as(who), body({ visibility: 'everyone', name: `Shared ${n}` }));
      }
      const id = idOf(await s.create.execute(s.as(who), body({ name: 'Private' })));

      const result = await s.update.execute(s.as(who), {
        id,
        name: 'Private',
        visibility: 'everyone',
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS },
      });
    });
  });

  describe('delete', () => {
    it('deletes the owner’s private filter without an audit row', async () => {
      const s = setup();
      const me = viewer();
      const id = idOf(await s.create.execute(s.as(me), body()));

      expect(await s.remove.execute(s.as(me), { id })).toEqual({ ok: true, value: { id } });
      expect(s.repo.rows.size).toBe(0);
      expect(s.audits).toEqual([]);
    });

    it('deletes a colleague’s shared filter only with the share key, and audits it', async () => {
      const s = setup();
      const id = idOf(await s.create.execute(s.as(owner()), body({ visibility: 'everyone' })));
      s.audits.length = 0;

      expect(failure(await s.remove.execute(s.as(viewer()), { id }))).toBe('access.denied');
      expect(s.repo.rows.size).toBe(1);
      expect(await s.remove.execute(s.as(owner()), { id })).toEqual({ ok: true, value: { id } });
      expect(s.repo.rows.size).toBe(0);
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        action: 'catalog.saved-filter.removed',
        before: { listKey: LIST, visibility: 'everyone' },
        after: { ownedByActor: false },
      });
    });

    it('answers not-found for a colleague’s private filter, another store’s filters, one already gone and another Market’s', async () => {
      const s = setup();
      const me = owner();
      const id = idOf(await s.create.execute(s.as(me), body()));
      const theirs = idOf(
        await s.create.execute(s.as(owner(STORE_B)), body({ visibility: 'everyone' })),
      );
      const there = member([VIEW, SHARE], STORE_A, otherMarket);

      // A colleague with the share key still cannot see a private filter.
      expect(failure(await s.remove.execute(s.as(owner()), { id }))).toBe('saved-filter.not-found');
      expect(failure(await s.remove.execute(s.as(me), { id }))).toBe('ok');
      expect(failure(await s.remove.execute(s.as(me), { id }))).toBe('saved-filter.not-found');
      expect(failure(await s.remove.execute(s.as(me), { id: theirs }))).toBe(
        'saved-filter.not-found',
      );
      expect(failure(await s.remove.execute(s.as(there), { id: theirs }))).toBe(
        'saved-filter.not-found',
      );
      expect(failure(await s.remove.execute(s.as(viewer()), { id: 'nope' }))).toBe(
        'saved-filter.not-found',
      );
      // Only the other store's filter is left.
      expect(s.repo.rows.size).toBe(1);
    });
  });
});
