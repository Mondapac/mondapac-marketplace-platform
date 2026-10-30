import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AccessDeclaration, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type {
  AdminProductRow,
  AdminProductsFilter,
  AdminProductsPageResult,
  AdminProductsReader,
} from '../ports/admin-products.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import { AdminProductsList } from './admin-products-list.use-case';

// `admin-products.list` in memory (catalog design 8.2, 9.2), on both Market fixtures: the access
// rule, the closed query, the status sets of the tabs, the counts, paging and the store names.
// The SQL behaviour is in test/db/catalog-admin-products.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-10-30T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('admin products list in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const locale = realPolicy.locales(market).default;

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
        sellerId,
      }),
    );

  const row = (overrides: Partial<AdminProductRow> = {}): AdminProductRow => ({
    productId: ids.next<'Product'>(),
    productCode: 'P00000001',
    name: 'Dates',
    primaryImageId: null,
    scope: 'SELLER',
    ownerSellerId: sellerId,
    categoryId: null,
    categoryName: null,
    typeCode: 'simple',
    status: 'published',
    offerCount: 2,
    updatedAt: T0,
    createdAt: T0,
    ...overrides,
  });

  function setup(
    options: {
      readonly rows?: readonly AdminProductRow[];
      readonly counts?: readonly number[];
      readonly page?: AdminProductsPageResult;
      readonly allow?: boolean;
      readonly unitFails?: boolean;
      readonly names?: ReadonlyMap<Id<'Seller'>, string>;
    } = {},
  ) {
    const checked: AccessDeclaration[] = [];
    const check: AuthorisationCheck = {
      check: (_context, declaration) => {
        checked.push(declaration);
        return Promise.resolve(
          options.allow === false
            ? { allowed: false, denial: { code: 'access.denied' } }
            : { allowed: true },
        );
      },
    };
    const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
    const unitOfWork = {
      run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
        units.push({ market: m.marketId, options: o });
        return options.unitFails === true
          ? Promise.resolve({ ok: false, error: new Error('down') })
          : work();
      },
    } as unknown as UnitOfWork;
    const countCalls: { market: string; filters: readonly AdminProductsFilter[] }[] = [];
    const listCalls: {
      market: string;
      filter: AdminProductsFilter;
      order: { sort: string; direction: string };
      page: { offset: number; limit: number };
    }[] = [];
    const reader: AdminProductsReader = {
      counts: (m, filters) => {
        countCalls.push({ market: m.marketId, filters });
        return Promise.resolve(options.counts ?? [3, 5, 2]);
      },
      list: (m, filter, order, page) => {
        listCalls.push({ market: m.marketId, filter, order, page });
        return Promise.resolve(options.page ?? { kind: 'rows', rows: options.rows ?? [] });
      },
    };
    const nameCalls: (readonly Id<'Seller'>[])[] = [];
    const sellerNames: SellerNamesReader = {
      storeNames: (_context, sellerIds) => {
        nameCalls.push(sellerIds);
        return Promise.resolve(options.names ?? new Map());
      },
    };
    const useCase = new AdminProductsList(createUseCaseGate(markets, check), {
      unitOfWork,
      adminProductsReader: reader,
      policy: realPolicy,
      sellerNames,
    });
    return { useCase, checked, units, countCalls, listCalls, nameCalls };
  }

  it('declares the permission rule under its own name', () => {
    expect(AdminProductsList.access).toEqual({
      name: 'catalog.admin-products-list',
      rule: { kind: 'permissions', allOf: ['catalog.product.view'] },
    });
  });

  it('asks the gate for the declared rule and reads nothing when it refuses', async () => {
    const { useCase, checked, units } = setup({ allow: false });

    const result = await useCase.execute(adminContext(), {});

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(checked.map((declaration) => declaration.name)).toEqual(['catalog.admin-products-list']);
    expect(units).toEqual([]);
  });

  it('refuses a seller session even when the permission check admits it', async () => {
    const { useCase, units } = setup();

    const result = await useCase.execute(sellerContext(), {});

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(units).toEqual([]);
  });

  it('lists the active tab by default, newest change first, in one read-only unit of the Market', async () => {
    const shown = row({ ownerSellerId: sellerId });
    const { useCase, units, countCalls, listCalls } = setup({
      rows: [shown],
      names: new Map([[sellerId, 'Dates & Co']]),
    });

    const result = await useCase.execute(adminContext(), {});

    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            productId: shown.productId,
            productCode: 'P00000001',
            name: 'Dates',
            primaryImageId: null,
            scope: 'SELLER',
            ownerSellerId: sellerId,
            ownerStoreName: 'Dates & Co',
            categoryId: null,
            categoryName: null,
            typeCode: 'simple',
            status: 'published',
            offerCount: 2,
            updatedAt: T0.toString(),
            createdAt: T0.toString(),
          },
        ],
        total: 3,
        page: 1,
        pageSize: 25,
        counts: { active: 3, all: 5, inactive: 2 },
      },
    });
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(countCalls).toHaveLength(1);
    expect(countCalls[0]!.market).toBe(code);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toMatchObject({
      market: code,
      order: { sort: 'updated', direction: 'desc' },
      page: { offset: 0, limit: 25 },
    });
    // The name is read in the Market's own default locale.
    expect(listCalls[0]!.filter.locale).toBe(locale);
  });

  it('maps each tab to its statuses, and counts all three for the same search', async () => {
    const { useCase, countCalls, listCalls } = setup();

    await useCase.execute(adminContext(), { view: 'inactive', q: '  dates ' });
    await useCase.execute(adminContext(), { view: 'all' });

    const [filters] = countCalls.map((call) => call.filters);
    expect(filters!.map((filter) => filter.statuses)).toEqual([
      ['published'],
      ['unpublished', 'published', 'matched', 'withdrawn', 'retired'],
      ['unpublished', 'withdrawn'],
    ]);
    expect(filters!.every((filter) => filter.text === 'dates')).toBe(true);
    expect(listCalls[0]!.filter.statuses).toEqual(['unpublished', 'withdrawn']);
    expect(listCalls[1]!.filter.statuses).toEqual([
      'unpublished',
      'published',
      'matched',
      'withdrawn',
      'retired',
    ]);
    // Neither tab shows a draft or a discarded product.
    for (const call of listCalls) {
      expect(call.filter.statuses).not.toContain('draft');
      expect(call.filter.statuses).not.toContain('discarded');
    }
  });

  it('narrows the tabs by the status filter, down to none', async () => {
    const { useCase, countCalls } = setup({ counts: [0, 4, 4] });

    const result = await useCase.execute(adminContext(), { view: 'active', status: 'withdrawn' });

    expect(countCalls[0]!.filters.map((filter) => filter.statuses)).toEqual([
      [],
      ['withdrawn'],
      ['withdrawn'],
    ]);
    expect(result).toMatchObject({ ok: true, value: { total: 0, items: [] } });
  });

  it('passes the filters, sort and page on, and the offset follows the page', async () => {
    const category = ids.next<'Category'>();
    const { useCase, listCalls } = setup({ counts: [60, 60, 0] });

    await useCase.execute(adminContext(), {
      view: 'active',
      scope: 'PLATFORM',
      categoryId: category,
      typeCode: 'simple',
      sellerId,
      sort: 'name',
      direction: 'desc',
      page: 3,
      pageSize: 20,
    });

    expect(listCalls[0]).toMatchObject({
      filter: {
        scope: 'PLATFORM',
        categoryId: category,
        typeCode: 'simple',
        sellerId,
        text: null,
      },
      order: { sort: 'name', direction: 'desc' },
      page: { offset: 40, limit: 20 },
    });
  });

  it('sorts by name ascending unless asked otherwise', async () => {
    const { useCase, listCalls } = setup();

    await useCase.execute(adminContext(), { sort: 'name' });
    await useCase.execute(adminContext(), { sort: 'created' });

    expect(listCalls.map((call) => call.order)).toEqual([
      { sort: 'name', direction: 'asc' },
      { sort: 'created', direction: 'desc' },
    ]);
  });

  it('answers an empty page without a list read when the page is past the end', async () => {
    const { useCase, listCalls } = setup({ counts: [3, 5, 2] });

    const result = await useCase.execute(adminContext(), { page: 2 });

    expect(result).toMatchObject({ ok: true, value: { items: [], total: 3, page: 2 } });
    expect(listCalls).toEqual([]);
  });

  it('asks for the store names of the distinct owners only, and gives none to a PLATFORM product', async () => {
    const other = ids.next<'Seller'>();
    const rows = [
      row({ ownerSellerId: sellerId }),
      row({ ownerSellerId: sellerId }),
      row({ ownerSellerId: other }),
      row({ scope: 'PLATFORM', ownerSellerId: null }),
    ];
    const { useCase, nameCalls } = setup({ rows, names: new Map([[sellerId, 'Dates & Co']]) });

    const result = await useCase.execute(adminContext(), {});

    expect(nameCalls).toEqual([[sellerId, other]]);
    expect(result.ok && result.value.items.map((item) => item.ownerStoreName)).toEqual([
      'Dates & Co',
      'Dates & Co',
      null,
      null,
    ]);
  });

  it('refuses a malformed query whole and before any read', async () => {
    const { useCase, units } = setup();
    const bad: [Record<string, unknown>, string, string][] = [
      [{ view: 'draft' }, 'view', 'value'],
      [{ status: 'draft' }, 'status', 'value'],
      [{ status: 'discarded' }, 'status', 'value'],
      [{ scope: 'ALL' }, 'scope', 'value'],
      [{ sort: 'price' }, 'sort', 'value'],
      [{ direction: 'up' }, 'direction', 'value'],
      [{ categoryId: 'nope' }, 'categoryId', 'format'],
      [{ sellerId: 'nope' }, 'sellerId', 'format'],
      [{ typeCode: 'No Space' }, 'typeCode', 'format'],
      [{ q: 'x'.repeat(101) }, 'q', 'length'],
      [{ q: ['a', 'b'] }, 'q', 'length'],
      [{ q: 'a\u0000b' }, 'q', 'format'],
      [{ page: 0 }, 'page', 'range'],
      [{ page: 1001 }, 'page', 'range'],
      [{ page: -1 }, 'page', 'range'],
      [{ pageSize: 101 }, 'pageSize', 'range'],
      [{ pageSize: 1.5 }, 'pageSize', 'range'],
      [{ pageSize: '25' }, 'pageSize', 'range'],
      [{ price: 1 }, 'price', 'unknown'],
    ];
    for (const [input, path, fieldCode] of bad) {
      expect(await useCase.execute(adminContext(), input)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code: fieldCode }] },
      });
    }
    expect(units).toEqual([]);
  });

  it('treats an empty search as no search', async () => {
    const { useCase, listCalls } = setup();

    await useCase.execute(adminContext(), { q: '   ' });

    expect(listCalls[0]!.filter.text).toBeNull();
  });

  it('asks the narrowing for a name sort that matches too many products', async () => {
    const { useCase } = setup({ page: { kind: 'too-broad' } });

    const result = await useCase.execute(adminContext(), { sort: 'name' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sort', code: 'too-broad' }] },
    });
  });

  it('answers access.unavailable when the unit cannot run', async () => {
    const { useCase } = setup({ unitFails: true });

    expect(await useCase.execute(adminContext(), {})).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });
});
