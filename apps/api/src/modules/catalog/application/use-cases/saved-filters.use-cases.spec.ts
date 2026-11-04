import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { MAX_SAVED_FILTERS_PER_OWNER, MAX_SHARED_SAVED_FILTERS } from '../../domain/saved-filter';
import type { AdminProductsFilter, AdminProductsReader } from '../ports/admin-products.reader';
import { MemorySavedFilters } from '../../../../../test/support/saved-filter-fakes';
import { SavedFilterCreate } from './saved-filter-create.use-case';
import { SavedFilterDelete } from './saved-filter-delete.use-case';
import { SavedFilterShareCheck } from './saved-filter-share-check.use-case';
import { SavedFilterUpdate } from './saved-filter-update.use-case';
import { COUNTED_SAVED_FILTERS, SavedFiltersList } from './saved-filters-list.use-case';

// The saved-filter use cases in memory (catalog design 9.2d), on both Market fixtures: the access
// rules (view key, share key, owner), the closed documents, the caps, the name uniques, the
// audit rows for filters shared with everyone, and that one Market never sees another's rows.
// The SQL behaviour is in test/db/catalog-saved-filters.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');
const LIST = 'admin.catalog.products';
const VIEW = 'catalog.product.view';
const SHARE = 'catalog.saved-filter.share';
const PAYLOAD = {
  v: 1,
  view: 'active',
  q: 'lamb',
  filters: { scope: 'SELLER', status: 'published' },
  sort: 'name',
  direction: 'asc',
};

describe.each(['AU', 'ZZ'] as const)('saved filters in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);

  /** An admin with the keys given; the gate admits a use case when the admin holds its keys. */
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
  const productsOnly = () => admin([VIEW]);
  const moderator = () => admin([VIEW, SHARE]);

  function setup(counts: readonly number[] | null = null) {
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
    const repo = new MemorySavedFilters();
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
    const countCalls: (readonly AdminProductsFilter[])[] = [];
    const reader = {
      counts: (_m: MarketContext, filters: readonly AdminProductsFilter[]) => {
        countCalls.push(filters);
        return Promise.resolve(counts ?? filters.map((_f, i) => 100 + i));
      },
    } as unknown as AdminProductsReader;
    const shareCheck = new SavedFilterShareCheck(gate);
    const base = { unitOfWork, savedFilters: repo, shareCheck };
    return {
      repo,
      audits,
      units,
      countCalls,
      create: new SavedFilterCreate(gate, { ...base, audit, clock, ids }),
      update: new SavedFilterUpdate(gate, { ...base, audit, clock }),
      remove: new SavedFilterDelete(gate, { ...base, audit }),
      list: new SavedFiltersList(gate, { ...base, adminProductsReader: reader, policy }),
      as(who: ReturnType<typeof admin>) {
        held.set(who.accountId, who.keys);
        return who.context;
      },
    };
  }

  const body = (overrides: Record<string, unknown> = {}) => ({
    listKey: LIST,
    name: 'Meat, active',
    visibility: 'me',
    payload: PAYLOAD,
    ...overrides,
  });
  const failure = (result: Result<unknown, { code: string }>) =>
    result.ok ? 'ok' : result.error.code;

  describe('declarations', () => {
    it('each use case declares the view key; the share check declares the share key', () => {
      for (const useCase of [
        SavedFiltersList,
        SavedFilterCreate,
        SavedFilterUpdate,
        SavedFilterDelete,
      ]) {
        expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
      }
      expect(SavedFilterShareCheck.access.rule).toEqual({ kind: 'permissions', allOf: [SHARE] });
    });
  });

  describe('create', () => {
    it('saves a private filter for a products-only admin, in canonical form, without an audit row', async () => {
      const s = setup();
      const me = productsOnly();

      const result = await s.create.execute(s.as(me), body({ name: '  Meat, active ' }));

      expect(result).toMatchObject({
        ok: true,
        value: {
          listKey: LIST,
          name: 'Meat, active',
          visibility: 'me',
          ownedByMe: true,
          canManage: true,
          count: null,
          payload: PAYLOAD,
        },
      });
      expect([...s.repo.rows.values()]).toHaveLength(1);
      expect([...s.repo.rows.values()][0]).toMatchObject({
        marketId: market.marketId,
        ownerAccountId: me.accountId,
        position: 1,
      });
      expect(s.audits).toEqual([]);
      expect(s.units).toEqual([
        { market: market.marketId, options: { isolation: 'serializable' } },
      ]);
    });

    it('refuses "everyone" without the share key and writes nothing', async () => {
      const s = setup();

      const result = await s.create.execute(s.as(productsOnly()), body({ visibility: 'everyone' }));

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(s.repo.rows.size).toBe(0);
      expect(s.units).toEqual([]);
    });

    it('saves a filter for everyone with the share key and audits it (ids and codes, no name)', async () => {
      const s = setup();

      const result = await s.create.execute(s.as(moderator()), body({ visibility: 'everyone' }));

      expect(result).toMatchObject({ ok: true, value: { visibility: 'everyone' } });
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        action: 'catalog.saved-filter.shared',
        targetType: 'catalog.saved-filter',
        after: { listKey: LIST, visibility: 'everyone' },
      });
      expect(JSON.stringify(s.audits)).not.toContain('Meat');
    });

    it('refuses a seller session and an admin without the view key', async () => {
      const s = setup();
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: ids.next<'Seller'>(),
        }),
      );
      const blind = admin([]);

      expect(failure(await s.create.execute(seller, body()))).toBe('access.denied');
      expect(failure(await s.create.execute(s.as(blind), body()))).toBe('access.denied');
      expect(s.repo.rows.size).toBe(0);
    });

    it.each([
      ['an unknown list', { listKey: 'admin.orders' }, 'listKey'],
      ['no list', { listKey: undefined }, 'listKey'],
      ['an empty name', { name: '   ' }, 'name'],
      ['a name of 61 characters', { name: 'x'.repeat(61) }, 'name'],
      ['a name with a control character', { name: 'a\u0007b' }, 'name'],
      ['a name that is not text', { name: 5 }, 'name'],
      ['another visibility', { visibility: 'team' }, 'visibility'],
      ['an unknown key in the body', { extra: 1 }, 'extra'],
      [
        'an unknown key in the payload',
        { payload: { ...PAYLOAD, columns: ['code'] } },
        'payload.columns',
      ],
      [
        'an unknown filter in the payload',
        { payload: { ...PAYLOAD, filters: { colour: 'red' } } },
        'payload.filters.colour',
      ],
      ['a payload of another version', { payload: { ...PAYLOAD, v: 2 } }, 'payload.v'],
      ['a tab that does not exist', { payload: { ...PAYLOAD, view: 'archived' } }, 'payload.view'],
      ['a sort that does not exist', { payload: { ...PAYLOAD, sort: 'price' } }, 'payload.sort'],
      [
        'a direction that does not exist',
        { payload: { ...PAYLOAD, direction: 'up' } },
        'payload.direction',
      ],
      [
        'a scope that does not exist',
        { payload: { ...PAYLOAD, filters: { scope: 'ALL' } } },
        'payload.filters.scope',
      ],
      [
        'a category that is no id',
        { payload: { ...PAYLOAD, filters: { categoryId: 'meat' } } },
        'payload.filters.categoryId',
      ],
      ['a search of 101 characters', { payload: { ...PAYLOAD, q: 'x'.repeat(101) } }, 'payload.q'],
      ['a payload that is not an object', { payload: 'view=all' }, 'payload'],
    ])('refuses %s as validation.failed naming the field', async (_label, overrides, path) => {
      const s = setup();

      const result = await s.create.execute(s.as(productsOnly()), body(overrides));

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path, code: expect.any(String) as string }],
        },
      });
      expect(s.repo.rows.size).toBe(0);
    });

    it('stores the payload canonically: a blank search and empty filters leave no key behind', async () => {
      const s = setup();

      const result = await s.create.execute(
        s.as(productsOnly()),
        body({ payload: { ...PAYLOAD, q: '  ', filters: undefined } }),
      );

      expect(result).toMatchObject({
        ok: true,
        value: { payload: { v: 1, view: 'active', filters: {}, sort: 'name', direction: 'asc' } },
      });
    });

    it('keeps one name per owner and list whatever its case, but lets two admins keep the same private name', async () => {
      const s = setup();
      const a = productsOnly();
      const b = productsOnly();
      await s.create.execute(s.as(a), body());

      expect(failure(await s.create.execute(s.as(a), body({ name: 'MEAT, ACTIVE' })))).toBe(
        'saved-filter.name-taken',
      );
      expect(failure(await s.create.execute(s.as(b), body()))).toBe('ok');
    });

    it('keeps one name among the filters shared with everyone', async () => {
      const s = setup();
      await s.create.execute(s.as(moderator()), body({ visibility: 'everyone' }));

      expect(
        failure(
          await s.create.execute(
            s.as(moderator()),
            body({ visibility: 'everyone', name: 'meat, ACTIVE' }),
          ),
        ),
      ).toBe('saved-filter.name-taken');
    });

    it(`stops at ${MAX_SAVED_FILTERS_PER_OWNER} filters per admin and list`, async () => {
      const s = setup();
      const me = productsOnly();
      const context = s.as(me);
      for (let n = 1; n <= MAX_SAVED_FILTERS_PER_OWNER; n++) {
        expect(failure(await s.create.execute(context, body({ name: `Filter ${n}` })))).toBe('ok');
      }

      const result = await s.create.execute(context, body({ name: 'One more' }));

      expect(result).toEqual({
        ok: false,
        error: { code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER },
      });
      // Another admin is not held back by it, and positions follow creation.
      expect(failure(await s.create.execute(s.as(productsOnly()), body()))).toBe('ok');
      const positions = [...s.repo.rows.values()]
        .filter((r) => r.ownerAccountId === me.accountId)
        .map((r) => r.position);
      expect(positions).toEqual(
        Array.from({ length: MAX_SAVED_FILTERS_PER_OWNER }, (_x, i) => i + 1),
      );
    });

    it(`stops at ${MAX_SHARED_SAVED_FILTERS} filters shared with everyone in a list, but a private one still saves`, async () => {
      const s = setup();
      for (let n = 1; n <= MAX_SHARED_SAVED_FILTERS; n++) {
        await s.create.execute(
          s.as(moderator()),
          body({ visibility: 'everyone', name: `Shared ${n}` }),
        );
      }

      const shared = await s.create.execute(
        s.as(moderator()),
        body({ visibility: 'everyone', name: 'Shared more' }),
      );

      expect(shared).toEqual({
        ok: false,
        error: { code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS },
      });
      expect(failure(await s.create.execute(s.as(moderator()), body({ name: 'Private' })))).toBe(
        'ok',
      );
    });
  });

  describe('list', () => {
    it('shows the caller their own filters first, then the shared ones of others, and never another admin’s private one', async () => {
      const s = setup();
      const me = productsOnly();
      const sam = moderator();
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
    });

    it('tells a holder of the share key they can manage a shared filter of somebody else', async () => {
      const s = setup();
      const sam = moderator();
      await s.create.execute(s.as(sam), body({ name: 'Sam shared', visibility: 'everyone' }));

      const result = await s.list.execute(s.as(moderator()), { listKey: LIST });

      expect(result).toMatchObject({
        ok: true,
        value: {
          canShare: true,
          items: [{ name: 'Sam shared', ownedByMe: false, canManage: true }],
        },
      });
    });

    it('counts the first filters with the list’s own filters and leaves the rest uncounted', async () => {
      const s = setup();
      const me = productsOnly();
      for (let n = 1; n <= COUNTED_SAVED_FILTERS + 2; n++) {
        await s.create.execute(s.as(me), body({ name: `F${n}` }));
      }

      const result = await s.list.execute(s.as(me), { listKey: LIST });

      const items = (result as unknown as { value: { items: { count: number | null }[] } }).value
        .items;
      expect(items.slice(0, COUNTED_SAVED_FILTERS).every((i) => typeof i.count === 'number')).toBe(
        true,
      );
      expect(items.slice(COUNTED_SAVED_FILTERS).map((i) => i.count)).toEqual([null, null]);
      expect(s.countCalls).toHaveLength(1);
      expect(s.countCalls[0]).toHaveLength(COUNTED_SAVED_FILTERS);
      // The saved tab, search and filters reach the counter as the list reads them.
      expect(s.countCalls[0]![0]).toMatchObject({
        text: 'lamb',
        scope: 'SELLER',
        matches: [{ status: 'published', paused: false }],
      });
    });

    it('leaves out a stored document that no longer reads as the list’s vocabulary', async () => {
      const s = setup();
      const me = productsOnly();
      await s.create.execute(s.as(me), body({ name: 'Good' }));
      await s.create.execute(s.as(me), body({ name: 'Old' }));
      const old = [...s.repo.rows.values()].find((r) => r.name === 'Old')!;
      s.repo.rows.set(`${market.marketId}/${old.id}`, { ...old, payload: { v: 9 } });

      const result = await s.list.execute(s.as(me), { listKey: LIST });

      const items = (result as unknown as { value: { items: { name: string }[] } }).value.items;
      expect(items.map((i) => i.name)).toEqual(['Good']);
    });

    it('is closed: an unknown query key or list is validation.failed', async () => {
      const s = setup();
      const me = s.as(productsOnly());

      expect(await s.list.execute(me, { listKey: LIST, page: 2 } as never)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page', code: 'unknown' }] },
      });
      expect(failure(await s.list.execute(me, {}))).toBe('validation.failed');
      expect(failure(await s.list.execute(me, { listKey: 'admin.orders' }))).toBe(
        'validation.failed',
      );
    });

    it('never shows another Market’s filters', async () => {
      const s = setup();
      const there = admin([VIEW, SHARE], otherMarket);
      await s.create.execute(s.as(there), body({ name: 'Elsewhere', visibility: 'everyone' }));

      const result = await s.list.execute(s.as(moderator()), { listKey: LIST });

      expect(result).toMatchObject({ ok: true, value: { items: [] } });
      expect([...s.repo.rows.values()][0]!.marketId).toBe(otherMarket.marketId);
    });
  });

  describe('update', () => {
    async function withFilter(visibility: 'me' | 'everyone', owner = moderator()) {
      const s = setup();
      const created = await s.create.execute(s.as(owner), body({ visibility }));
      const id = (created as { value: { id: string } }).value.id;
      s.audits.length = 0;
      return { s, owner, id };
    }

    it('lets the owner rename a private filter, whatever the case of the new name', async () => {
      const { s, owner, id } = await withFilter('me');

      const result = await s.update.execute(s.as(owner), {
        id,
        name: 'meat, ACTIVE',
        visibility: 'me',
      });

      expect(result).toMatchObject({ ok: true, value: { name: 'meat, ACTIVE', visibility: 'me' } });
      expect(s.audits).toEqual([]);
    });

    it('shares a private filter only with the share key, and audits the change', async () => {
      const { s, owner, id } = await withFilter('me');
      const plain = productsOnly();
      const mine = await s.create.execute(s.as(plain), body({ name: 'Plain' }));
      const plainId = (mine as { value: { id: string } }).value.id;

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
        await s.update.execute(s.as(owner), { id, name: 'Meat, active', visibility: 'everyone' }),
      ).toMatchObject({ ok: true, value: { visibility: 'everyone' } });
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        action: 'catalog.saved-filter.changed',
        before: { visibility: 'me' },
        after: { visibility: 'everyone', renamed: false, ownedByActor: true },
      });
    });

    it('lets the owner unshare and rename their shared filter even after losing the share key', async () => {
      const { s, owner, id } = await withFilter('everyone');
      // The same account, now with the view key only.
      const demoted = { ...owner, keys: [VIEW] };

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

    it('lets a holder of the share key change a shared filter of somebody else, and says so in the audit row', async () => {
      const { s, id } = await withFilter('everyone');

      const result = await s.update.execute(s.as(moderator()), {
        id,
        name: 'Their rename',
        visibility: 'everyone',
      });

      expect(result).toMatchObject({ ok: true, value: { name: 'Their rename', ownedByMe: false } });
      expect(s.audits[0]).toMatchObject({ after: { renamed: true, ownedByActor: false } });
    });

    it('refuses an admin without the share key on somebody else’s shared filter: access.denied', async () => {
      const { s, id } = await withFilter('everyone');

      const result = await s.update.execute(s.as(productsOnly()), {
        id,
        name: 'Mine now',
        visibility: 'everyone',
      });

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect([...s.repo.rows.values()][0]!.name).toBe('Meat, active');
    });

    it('answers not-found for somebody else’s private filter, an unknown id and a malformed id alike', async () => {
      const { s, id } = await withFilter('me');
      const stranger = s.as(moderator());

      for (const target of [id, ids.next<'SavedFilter'>(), 'not-an-id']) {
        expect(
          await s.update.execute(stranger, { id: target, name: 'X', visibility: 'me' }),
        ).toEqual({
          ok: false,
          error: { code: 'saved-filter.not-found' },
        });
      }
    });

    it('answers name-taken for a name the owner already uses and writes nothing', async () => {
      const { s, owner, id } = await withFilter('me');
      await s.create.execute(s.as(owner), body({ name: 'Other' }));

      const result = await s.update.execute(s.as(owner), { id, name: 'other', visibility: 'me' });

      expect(result).toEqual({ ok: false, error: { code: 'saved-filter.name-taken' } });
    });

    it('writes nothing when the name and visibility are the same', async () => {
      const { s, owner, id } = await withFilter('everyone');
      const before = [...s.repo.rows.values()][0]!.updatedAt;
      clock.advance(Temporal.Duration.from({ seconds: 1 }));

      const result = await s.update.execute(s.as(owner), {
        id,
        name: 'Meat, active',
        visibility: 'everyone',
      });

      expect(result).toMatchObject({ ok: true });
      expect([...s.repo.rows.values()][0]!.updatedAt).toEqual(before);
      expect(s.audits).toEqual([]);
    });

    it('is closed and complete: both fields are needed and nothing else is read', async () => {
      const { s, owner, id } = await withFilter('me');
      const context = s.as(owner);

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
      const owner = moderator();
      for (let n = 1; n <= MAX_SHARED_SAVED_FILTERS; n++) {
        await s.create.execute(s.as(owner), body({ visibility: 'everyone', name: `Shared ${n}` }));
      }
      const created = await s.create.execute(s.as(owner), body({ name: 'Private' }));
      const id = (created as { value: { id: string } }).value.id;

      const result = await s.update.execute(s.as(owner), {
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
      const me = productsOnly();
      const created = await s.create.execute(s.as(me), body());
      const id = (created as { value: { id: string } }).value.id;

      expect(await s.remove.execute(s.as(me), { id })).toEqual({ ok: true, value: { id } });
      expect(s.repo.rows.size).toBe(0);
      expect(s.audits).toEqual([]);
    });

    it('deletes a shared filter of somebody else only with the share key, and audits it', async () => {
      const s = setup();
      const created = await s.create.execute(s.as(moderator()), body({ visibility: 'everyone' }));
      const id = (created as { value: { id: string } }).value.id;
      s.audits.length = 0;

      expect(failure(await s.remove.execute(s.as(productsOnly()), { id }))).toBe('access.denied');
      expect(s.repo.rows.size).toBe(1);
      expect(await s.remove.execute(s.as(moderator()), { id })).toEqual({
        ok: true,
        value: { id },
      });
      expect(s.repo.rows.size).toBe(0);
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        action: 'catalog.saved-filter.removed',
        before: { listKey: LIST, visibility: 'everyone' },
        after: { ownedByActor: false },
      });
    });

    it('answers not-found for somebody else’s private filter, one already gone and another Market’s', async () => {
      const s = setup();
      const created = await s.create.execute(s.as(moderator()), body());
      const id = (created as { value: { id: string } }).value.id;
      const there = admin([VIEW, SHARE], otherMarket);

      expect(failure(await s.remove.execute(s.as(moderator()), { id }))).toBe(
        'saved-filter.not-found',
      );
      expect(failure(await s.remove.execute(s.as(there), { id }))).toBe('saved-filter.not-found');
      expect(failure(await s.remove.execute(s.as(productsOnly()), { id: 'nope' }))).toBe(
        'saved-filter.not-found',
      );
      expect(s.repo.rows.size).toBe(1);
    });
  });
});
