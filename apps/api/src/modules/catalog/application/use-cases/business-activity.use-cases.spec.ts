import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { cleanClaimTextMatcher } from '../../../../../test/support/clean-claim-text-matcher.fake';
import { unavailableClaimTextMatcher } from '../../../../../test/support/unavailable-claim-text-matcher.fake';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { BusinessActivityState } from '../../domain/business-activity';
import type { StoredCategoryNode } from '../../domain/category-tree';
import type {
  BusinessActivityReader,
  BusinessActivityListQuery,
} from '../ports/business-activity.reader';
import type { BusinessActivityRepository } from '../ports/business-activity.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import { BusinessActivityCreate } from './business-activity-create.use-case';
import { BusinessActivityEdit } from './business-activity-edit.use-case';
import { BusinessActivityGet } from './business-activity-get.use-case';
import { BusinessActivityList } from './business-activity-list.use-case';

// The business-activity use cases in memory, on both Market fixtures: the required default-locale
// name, claim-word refusal (and a matcher that is down fails closed), the level 1-2 category rule,
// code derivation and uniqueness, the version check, and the admin-only rule. The database
// behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'ar'] } },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] } },
] as const;

describe.each(FIXTURES)('business-activity use cases in market $code', ({ code, locales }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const main = locales.default;
  const second = locales.supported.find((l) => l !== main)!;

  const rows = new Map<string, BusinessActivityState>();
  let taken: 'business-activity.name-taken' | null = null;
  const activities: BusinessActivityRepository = {
    add: (_m, state) => {
      if ([...rows.values()].some((row) => row.code === state.code)) {
        return Promise.resolve('business-activity.code-taken');
      }
      rows.set(state.id, state);
      return Promise.resolve(null);
    },
    findById: (_m, id) => Promise.resolve(rows.get(id) ?? null),
    codeTaken: (_m, wanted) => Promise.resolve([...rows.values()].some((r) => r.code === wanted)),
    save: (_m, state, expectedVersion) => {
      if (rows.get(state.id)?.version !== expectedVersion) {
        throw new StaleAggregateError('business-activity', state.id);
      }
      if (taken !== null) return Promise.resolve(taken);
      rows.set(state.id, state);
      return Promise.resolve(null);
    },
  };
  const activityReader: BusinessActivityReader = {
    list: (_m, query: BusinessActivityListQuery) =>
      Promise.resolve({
        items: [...rows.values()].filter((r) => query.status === null || r.status === query.status),
        nextAfterId: null,
      }),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const policy = {
    locales: () => ({ default: main, supported: [...locales.supported] }),
  } as unknown as CatalogMarketPolicy;

  const node = (
    n: number,
    parent: Id<'Category'> | null,
    status: StoredCategoryNode['status'] = 'active',
  ): StoredCategoryNode => ({
    id: cat(n),
    parentId: parent,
    status,
    mergedIntoId: null,
    slug: `c${n}`,
    names: status === 'active' ? [{ locale: main, name: `Category ${n}` }] : [],
  });
  const cat = (n: number): Id<'Category'> =>
    `01990000-0000-7000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
  // 1 and 2 are top-level, 3 is under 1 (level 2), 4 is under 3 (level 3), 5 is archived.
  const treeReader: CategoryTreeReader = {
    nodes: () =>
      Promise.resolve([
        node(1, null),
        node(2, null),
        node(3, cat(1)),
        node(4, cat(3)),
        node(5, null, 'archived'),
      ]),
  };

  const build = (matcher: ClaimTextMatcher = cleanClaimTextMatcher) => ({
    create: new BusinessActivityCreate(gate, {
      unitOfWork,
      activities,
      treeReader,
      policy,
      matcher,
      clock,
      ids,
    }),
    edit: new BusinessActivityEdit(gate, {
      unitOfWork,
      activities,
      treeReader,
      policy,
      matcher,
      clock,
    }),
    get: new BusinessActivityGet(gate, { unitOfWork, activities }),
    list: new BusinessActivityList(gate, { unitOfWork, activityReader }),
  });

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );
  const admin = contextOf('admin');

  beforeEach(() => {
    rows.clear();
    taken = null;
  });

  it('declares permission rules under their own names', () => {
    expect(BusinessActivityCreate.access).toEqual({
      name: 'catalog.business-activity-create',
      rule: { kind: 'permissions', allOf: ['catalog.business-activity.edit'] },
    });
    expect(BusinessActivityEdit.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.business-activity.edit'],
    });
    expect(BusinessActivityGet.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.business-activity.read'],
    });
    expect(BusinessActivityList.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.business-activity.read'],
    });
  });

  it('creates an active activity with a code derived from the default-locale name', async () => {
    const { create } = build();

    const result = await create.execute(admin, {
      names: { [main]: 'Fresh Butcher', [second]: 'جزار' },
      description: 'Meat counter',
      categoryIds: [cat(1), cat(3)],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.activity).toMatchObject({
      code: 'fresh-butcher',
      status: 'active',
      names: { [main]: 'Fresh Butcher', [second]: 'جزار' },
      description: 'Meat counter',
      categoryIds: [cat(1), cat(3)],
      version: 1,
    });
  });

  it('suffixes a derived code that is taken and refuses a given code that is taken', async () => {
    const { create } = build();
    await create.execute(admin, { names: { [main]: 'Grocery' } });

    const again = await create.execute(admin, { names: { [main]: 'Grocery' } });
    const given = await create.execute(admin, {
      code: 'grocery',
      names: { [main]: 'Other grocery' },
    });

    expect(again.ok && again.value.activity.code).toBe('grocery-2');
    expect(given).toEqual({ ok: false, error: { code: 'business-activity.code-taken' } });
  });

  it('refuses a missing default-locale name, an unknown key and a bad code', async () => {
    const { create } = build();

    expect(await create.execute(admin, { names: { [second]: 'جزار' } })).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: `names.${main}`, code: 'required' }],
      },
    });
    expect(await create.execute(admin, { names: { [main]: 'A' }, extra: 1 } as never)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'extra', code: 'unknown' }] },
    });
    expect(await create.execute(admin, { names: { [main]: 'A' }, code: 'Bad Code' })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] },
    });
  });

  it('refuses a name that asserts a certification and fails closed when the matcher is down', async () => {
    const hit = { typeCode: 'halal', span: { fromToken: 0, toToken: 0 } };
    const matcher: ClaimTextMatcher = {
      match: (_c, texts) =>
        Promise.resolve(ok(texts.map((t) => (t.text.includes('Halal') ? [hit] : [])))),
    };

    const refused = await build(matcher).create.execute(admin, {
      names: { [main]: 'Halal Butcher' },
      description: 'Plain text',
    });
    const down = await build(unavailableClaimTextMatcher).create.execute(admin, {
      names: { [main]: 'Butcher' },
    });

    expect(refused).toEqual({
      ok: false,
      error: {
        code: 'business-activity.claim-word',
        fields: [{ path: `names.${main}`, code: 'claim-word' }],
      },
    });
    expect(down).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(rows.size).toBe(0);
  });

  it('links only live categories on level 1 or 2', async () => {
    const { create } = build();

    const result = await create.execute(admin, {
      names: { [main]: 'Grocery' },
      categoryIds: [cat(2), cat(4), cat(5), cat(9)],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'categoryIds.1', code: 'too-deep' },
          { path: 'categoryIds.2', code: 'unknown' },
          { path: 'categoryIds.3', code: 'unknown' },
        ],
      },
    });
  });

  it('refuses everyone who is not an admin', async () => {
    const { create, edit, get, list } = build();
    const seller = contextOf('seller');

    for (const result of [
      await create.execute(seller, { names: { [main]: 'A' } }),
      await edit.execute(seller, { activityId: 'x', version: 1, names: { [main]: 'A' } }),
      await get.execute(seller, { activityId: 'x' }),
      await list.execute(seller, {}),
    ]) {
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    }
  });

  describe('edit', () => {
    async function created() {
      const result = await build().create.execute(admin, {
        names: { [main]: 'Grocery' },
        categoryIds: [cat(1)],
      });
      if (!result.ok) throw new Error('setup');
      return result.value.activity;
    }

    it('replaces the content, keeps the code and raises the version', async () => {
      const activity = await created();

      const result = await build().edit.execute(admin, {
        activityId: activity.id,
        version: 1,
        status: 'inactive',
        names: { [main]: 'Groceries', [second]: 'بقالة' },
        categoryIds: [cat(2)],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.activity).toMatchObject({
        code: 'grocery',
        status: 'inactive',
        names: { [main]: 'Groceries', [second]: 'بقالة' },
        description: null,
        categoryIds: [cat(2)],
        version: 2,
      });
    });

    it('keeps the status when it is left out', async () => {
      const activity = await created();

      const result = await build().edit.execute(admin, {
        activityId: activity.id,
        version: 1,
        names: { [main]: 'Grocery' },
      });

      expect(result.ok && result.value.activity.status).toBe('active');
    });

    it('answers conflict.stale for an old version, not-found for an unknown id', async () => {
      const activity = await created();

      expect(
        await build().edit.execute(admin, {
          activityId: activity.id,
          version: 7,
          names: { [main]: 'Grocery' },
        }),
      ).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(
        await build().edit.execute(admin, {
          activityId: 'not-an-id',
          version: 1,
          names: { [main]: 'Grocery' },
        }),
      ).toEqual({ ok: false, error: { code: 'business-activity.not-found' } });
    });

    it('answers name-taken when the store refuses a name', async () => {
      const activity = await created();
      taken = 'business-activity.name-taken';

      const result = await build().edit.execute(admin, {
        activityId: activity.id,
        version: 1,
        names: { [main]: 'Other' },
      });

      expect(result).toEqual({ ok: false, error: { code: 'business-activity.name-taken' } });
    });
  });

  it('reads one activity and lists by status', async () => {
    const { create, get, list } = build();
    const a = await create.execute(admin, { names: { [main]: 'Grocery' } });
    if (!a.ok) throw new Error('setup');

    expect(await get.execute(admin, { activityId: a.value.activity.id })).toEqual({
      ok: true,
      value: { activity: a.value.activity },
    });
    expect(await get.execute(admin, { activityId: cat(1) })).toEqual({
      ok: false,
      error: { code: 'business-activity.not-found' },
    });
    const all = await list.execute(admin, {});
    expect(all.ok && all.value.items.map((i) => i.code)).toEqual(['grocery']);
    expect(await list.execute(admin, { status: 'inactive' })).toEqual({
      ok: true,
      value: { items: [], nextAfterId: null },
    });
    expect(await list.execute(admin, { limit: 0 })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
    });
  });
});
