import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AdminStoredCategory } from '../../domain/category-admin-tree';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { OwnCategoryPicker } from './own-category-picker.use-case';
import { PlatformCategoryPicker } from './platform-category-picker.use-case';

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');

// AU allows depth 4, ZZ depth 3 (Market config `catalog.maxCategoryDepth`).
const FIXTURES = [
  { code: 'AU', depth: 4, ids: ['s1', 'c1', 'ch'] },
  { code: 'ZZ', depth: 3, ids: ['c1', 'ch'] },
] as const;

describe.each(FIXTURES)('category picker in market $code', ({ code, depth, ids: expected }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const gen = new SequenceIdGenerator(clock);
  const held = new Set(['catalog.own-product.edit', 'catalog.platform-product.edit']);
  const check: AuthorisationCheck = {
    check: (_c, declaration) => {
      const rule = declaration.rule;
      const keys = rule.kind === 'permissions' ? rule.allOf : [];
      return Promise.resolve(
        keys.every((key) => held.has(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  const gate = createUseCaseGate(markets, check);
  const node = (
    id: string,
    parent: string | null,
    status: AdminStoredCategory['status'] = 'active',
  ): AdminStoredCategory => ({
    id: id as Id<'Category'>,
    parentId: parent as Id<'Category'> | null,
    slug: id,
    status,
    mergedIntoId: null,
    names: [{ locale: 'en', name: id.toUpperCase() }],
    revisionNo: 1,
    version: 1,
    position: id === 'ch' ? 1 : 0,
    showInMenu: true,
  });
  // d > g > c1 > s1; g > ch (hidden)
  const nodes = [
    node('d', null),
    node('g', 'd'),
    node('c1', 'g'),
    node('s1', 'c1'),
    node('ch', 'g', 'hidden'),
  ];
  // The other Market's tree (its own ids): a reader scoped by the request's Market never mixes them.
  const otherNodes = [node('xd', null), node('xg', 'xd'), node('xc', 'xg')];
  const reader = {
    categories: (m: MarketContext) =>
      Promise.resolve(m.marketId === market.marketId ? nodes : otherNodes),
  } as unknown as AdminCategoryReader;
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const policy = {
    locales: () => ({ default: 'en', supported: ['en'] }),
    maxCategoryDepth: () => depth,
  } as unknown as CatalogMarketPolicy;
  const deps = { unitOfWork, adminCategoryReader: reader, policy };
  const own = new OwnCategoryPicker(gate, deps);
  const platform = new PlatformCategoryPicker(gate, deps);
  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: gen.next<'Account'>(),
        sessionId: gen.next<'Session'>(),
        sellerId: population === 'seller' ? gen.next<'Seller'>() : null,
      }),
    );

  it('gives a seller levels 3 and up to the Market depth, with General last and no hidden node', async () => {
    const result = await own.execute(contextOf('seller'), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.choices.map((c) => c.id);
    expect(ids).toEqual(expected.filter((id) => id !== 'ch'));
    expect(result.value.choices.find((c) => c.id === 'c1')?.general).toBe(depth === 4);
  });

  it('gives an admin the hidden node too', async () => {
    const result = await platform.execute(contextOf('admin'), {});
    expect(result.ok && result.value.choices.map((c) => c.id)).toEqual(expected);
  });

  it("offers only this Market's categories, to a seller and to an admin", async () => {
    const seller = await own.execute(contextOf('seller'), {});
    const admin = await platform.execute(contextOf('admin'), {});
    for (const result of [seller, admin]) {
      const ids = result.ok ? result.value.choices.map((c) => c.id) : [];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.some((id) => id.startsWith('x'))).toBe(false);
    }
  });

  it('refuses the wrong population and declares the keys', async () => {
    expect((await own.execute(contextOf('admin'), {})).ok).toBe(false);
    expect((await platform.execute(contextOf('seller'), {})).ok).toBe(false);
    expect(OwnCategoryPicker.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.own-product.edit'],
    });
    expect(PlatformCategoryPicker.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.platform-product.edit'],
    });
  });
});
