import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
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
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type {
  AdminProductsFilter,
  AdminProductsReader,
  ProductState,
} from '../ports/admin-products.reader';
import { AdminProductsBulk, BULK_MAX_IDS, BULK_MAX_SELECTED } from './admin-products-bulk.use-case';
import type { AdminProductPause } from './admin-product-pause.use-case';
import type { AdminProductResume } from './admin-product-resume.use-case';
import type { AdminProductWithdraw } from './admin-product-withdraw.use-case';
import type { PlatformProductRetire } from './platform-product-retire.use-case';

// `admin-products.bulk` in memory (catalog design 9.2c), on both Market fixtures: the closed
// request, the per-item results, the skip reasons, the count confirmation of a PLATFORM Delete,
// the dry run, and that the single use cases (and so their keys) run once per product. The
// single use cases are fakes here; their own behaviour is in the db specs.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-10-30T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('admin products bulk in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const adminContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  const sellerContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );

  const state = (overrides: Partial<ProductState> = {}): ProductState => ({
    productId: ids.next<'Product'>(),
    scope: 'SELLER',
    status: 'published',
    paused: false,
    offerCount: 2,
    ...overrides,
  });

  type Answer = Result<unknown, { readonly code: string }>;
  function setup(
    states: readonly ProductState[],
    options: {
      readonly answers?: (action: string, productId: string) => Answer;
      readonly allow?: boolean;
      readonly selected?: readonly Id<'Product'>[];
      readonly total?: number;
    } = {},
  ) {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const filters: AdminProductsFilter[] = [];
    const single = (action: string) => ({
      execute: (_context: CallContext, input: { productId: string }): Promise<Answer> => {
        calls.push({ action, input });
        return Promise.resolve(options.answers?.(action, input.productId) ?? ok({}));
      },
    });
    const reader: AdminProductsReader = {
      list: () => Promise.reject(new Error('not used')),
      counts: () => Promise.resolve([options.total ?? states.length]),
      ids: (_m, filter, limit) => {
        filters.push(filter);
        return Promise.resolve(
          (options.selected ?? states.map((s) => s.productId)).slice(0, limit),
        );
      },
      existing: (_m, wanted) =>
        Promise.resolve(
          new Set(
            states
              .map((s) => s.productId as string)
              .filter((id) => wanted.includes(id as Id<'Product'>)),
          ),
        ),
      states: (_m, wanted) => Promise.resolve(states.filter((s) => wanted.includes(s.productId))),
      rowsByIds: () => Promise.resolve([]),
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const check: AuthorisationCheck = {
      check: () =>
        Promise.resolve(
          options.allow === false
            ? { allowed: false, denial: { code: 'access.denied' } }
            : { allowed: true },
        ),
    };
    const useCase = new AdminProductsBulk(createUseCaseGate(markets, check), {
      unitOfWork,
      adminProductsReader: reader,
      policy: realPolicy,
      pause: single('pause') as unknown as AdminProductPause,
      resume: single('resume') as unknown as AdminProductResume,
      withdraw: single('withdraw') as unknown as AdminProductWithdraw,
      retire: single('retire') as unknown as PlatformProductRetire,
    });
    return { useCase, calls, filters };
  }

  it('declares the view key and refuses a seller session', async () => {
    expect(AdminProductsBulk.access).toEqual({
      name: 'catalog.admin-products-bulk',
      rule: { kind: 'permissions', allOf: ['catalog.product.view'] },
    });
    const s = state();
    const { useCase, calls } = setup([s]);

    const result = await useCase.execute(sellerContext(), {
      action: 'pause',
      productIds: [s.productId],
    });

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(calls).toEqual([]);
  });

  it('pauses each product through its own use case and lists a result per product', async () => {
    const a = state();
    const b = state({ paused: true });
    const c = state({ status: 'unpublished' });
    const { useCase, calls } = setup([a, b, c], {
      answers: (_action, productId) =>
        productId === b.productId
          ? err({ code: 'product.already-paused' })
          : productId === c.productId
            ? err({ code: 'product.not-published' })
            : ok({}),
    });

    const result = await useCase.execute(adminContext(), {
      action: 'pause',
      productIds: [a.productId, b.productId, c.productId],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        action: 'pause',
        dryRun: false,
        requested: 3,
        eligible: 1,
        counts: { done: 1, skipped: 2, failed: 0 },
        results: [
          { productId: a.productId, outcome: 'done' },
          { productId: b.productId, outcome: 'skipped', reason: 'product.already-paused' },
          { productId: c.productId, outcome: 'skipped', reason: 'product.not-published' },
        ],
      },
    });
    // One unit per product: every product went through the single use case, none twice.
    expect(calls.map((call) => call.input['productId']).sort()).toEqual(
      [a.productId, b.productId, c.productId].sort(),
    );
  });

  it('reports a product that fails as failed, and goes on with the others', async () => {
    const a = state();
    const b = state();
    const { useCase } = setup([a, b], {
      answers: (_action, productId) =>
        productId === a.productId ? err({ code: 'claim.check-unavailable' }) : ok({}),
    });

    const result = await useCase.execute(adminContext(), {
      action: 'resume',
      productIds: [a.productId, b.productId],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        counts: { done: 1, skipped: 0, failed: 1 },
        results: [
          { productId: a.productId, outcome: 'failed', reason: 'claim.check-unavailable' },
          { productId: b.productId, outcome: 'done' },
        ],
      },
    });
  });

  it('refuses the request when every product is denied for the action key', async () => {
    const a = state();
    const { useCase } = setup([a], { answers: () => err({ code: 'access.denied' }) });

    const result = await useCase.execute(adminContext(), {
      action: 'pause',
      productIds: [a.productId],
    });

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
  });

  it('answers product.not-found for any id that is no product of the Market', async () => {
    const known = state();
    const { useCase, calls } = setup([known]);

    const result = await useCase.execute(adminContext(), {
      action: 'pause',
      productIds: [known.productId, ids.next<'Product'>()],
    });

    expect(result).toEqual({ ok: false, error: { code: 'product.not-found' } });
    expect(calls).toEqual([]);
  });

  describe('Delete', () => {
    it('withdraws a SELLER product and retires a PLATFORM one with its Offer count', async () => {
      const seller = state({ scope: 'SELLER', offerCount: 1 });
      const platform = state({ scope: 'PLATFORM', offerCount: 4 });
      const { useCase, calls } = setup([seller, platform]);

      const result = await useCase.execute(adminContext(), {
        action: 'delete',
        productIds: [seller.productId, platform.productId],
        confirmOfferCount: 4,
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          counts: { done: 2, skipped: 0, failed: 0 },
          confirmOfferCount: 4,
          affectedOfferCount: 5,
        },
      });
      expect(calls).toEqual(
        expect.arrayContaining([
          { action: 'withdraw', input: { productId: seller.productId } },
          { action: 'retire', input: { productId: platform.productId, confirmOfferCount: 4 } },
        ]),
      );
    });

    it('needs the confirmation for PLATFORM products, and refuses a stale count with the current one', async () => {
      const platform = state({ scope: 'PLATFORM', offerCount: 4 });
      const { useCase, calls } = setup([platform]);

      expect(
        await useCase.execute(adminContext(), {
          action: 'delete',
          productIds: [platform.productId],
        }),
      ).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path: 'confirmOfferCount', code: 'required' }],
        },
      });
      expect(
        await useCase.execute(adminContext(), {
          action: 'delete',
          productIds: [platform.productId],
          confirmOfferCount: 3,
        }),
      ).toEqual({ ok: false, error: { code: 'retire.count-changed', currentCount: 4 } });
      expect(calls).toEqual([]);
    });

    it('needs no confirmation when only SELLER products are deleted', async () => {
      const seller = state({ scope: 'SELLER' });
      const { useCase } = setup([seller]);

      const result = await useCase.execute(adminContext(), {
        action: 'delete',
        productIds: [seller.productId],
      });

      expect(result).toMatchObject({ ok: true, value: { counts: { done: 1 } } });
    });

    it('does not count a PLATFORM product that cannot be retired toward the confirmation', async () => {
      const unpublished = state({ scope: 'PLATFORM', status: 'unpublished', offerCount: 9 });
      const { useCase } = setup([unpublished], {
        answers: () => err({ code: 'product.not-published' }),
      });

      const result = await useCase.execute(adminContext(), {
        action: 'delete',
        productIds: [unpublished.productId],
      });

      expect(result).toMatchObject({
        ok: true,
        value: { confirmOfferCount: 0, counts: { done: 0, skipped: 1, failed: 0 } },
      });
    });
  });

  describe('dry run', () => {
    it('changes nothing and answers what the confirm dialog shows', async () => {
      const seller = state({ scope: 'SELLER', offerCount: 2 });
      const platform = state({ scope: 'PLATFORM', offerCount: 6 });
      const retired = state({ scope: 'PLATFORM', status: 'retired', offerCount: 1 });
      const { useCase, calls } = setup([seller, platform, retired]);

      const result = await useCase.execute(adminContext(), {
        action: 'delete',
        productIds: [seller.productId, platform.productId, retired.productId],
        dryRun: true,
      });

      expect(result).toEqual({
        ok: true,
        value: {
          action: 'delete',
          dryRun: true,
          requested: 3,
          eligible: 2,
          confirmOfferCount: 6,
          affectedOfferCount: 8,
          counts: { done: 0, skipped: 0, failed: 0 },
          results: [],
        },
      });
      expect(calls).toEqual([]);
    });
  });

  describe('selector', () => {
    it('resolves the products of a tab and its filters ("Select all N in this filter")', async () => {
      const a = state();
      const b = state();
      const { useCase, filters } = setup([a, b]);

      const result = await useCase.execute(adminContext(), {
        action: 'pause',
        selector: { view: 'active', q: ' dates ', scope: 'SELLER' },
      });

      expect(result).toMatchObject({ ok: true, value: { requested: 2, counts: { done: 2 } } });
      expect(filters).toHaveLength(1);
      expect(filters[0]).toMatchObject({
        matches: [{ status: 'published', paused: false }],
        text: 'dates',
        scope: 'SELLER',
        locale: realPolicy.locales(market).default,
      });
    });

    it('refuses a selector that matches more than the cap, naming the total', async () => {
      const many = Array.from({ length: BULK_MAX_SELECTED + 1 }, () => ids.next<'Product'>());
      const { useCase } = setup([], { selected: many, total: 2500 });

      const result = await useCase.execute(adminContext(), {
        action: 'pause',
        selector: { view: 'all' },
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: BULK_MAX_SELECTED, total: 2500 },
      });
    });

    it('refuses a selector that matches nothing', async () => {
      const { useCase } = setup([], { selected: [] });

      expect(
        await useCase.execute(adminContext(), { action: 'pause', selector: { view: 'inactive' } }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });
  });

  describe('request validation', () => {
    it.each([
      ['not an object', 'x'],
      ['an unknown key', { action: 'pause', productIds: ['x'], extra: 1 }],
      ['an unknown action', { action: 'archive', productIds: ['x'] }],
      ['neither ids nor selector', { action: 'pause' }],
      ['both ids and selector', { action: 'pause', productIds: [], selector: {} }],
      ['an empty id list', { action: 'pause', productIds: [] }],
      ['an id that is no UUID', { action: 'pause', productIds: ['nope'] }],
      ['a non-boolean dryRun', { action: 'pause', productIds: [], dryRun: 'yes' }],
      ['a negative confirmation', { action: 'delete', productIds: [], confirmOfferCount: -1 }],
      ['an unknown selector key', { action: 'pause', selector: { nope: 1 } }],
    ])('refuses %s as validation.failed', async (_name, input) => {
      const { useCase, calls } = setup([]);

      const result = await useCase.execute(adminContext(), input as never);

      expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(calls).toEqual([]);
    });

    it('refuses more than the id cap before reading anything', async () => {
      const { useCase } = setup([]);
      const many = Array.from({ length: BULK_MAX_IDS + 1 }, () => ids.next<'Product'>());

      expect(await useCase.execute(adminContext(), { action: 'pause', productIds: many })).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: BULK_MAX_IDS },
      });
    });

    it('refuses a repeated id', async () => {
      const a = state();
      const { useCase } = setup([a]);

      expect(
        await useCase.execute(adminContext(), {
          action: 'pause',
          productIds: [a.productId, a.productId],
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });
  });
});
