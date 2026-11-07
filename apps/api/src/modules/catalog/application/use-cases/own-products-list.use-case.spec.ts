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
  OwnCatalogReader,
  OwnProductRow,
  OwnProductsFilter,
  OwnProductsPageResult,
} from '../ports/own-catalog.reader';
import { MAX_OWN_LIST_ROWS, OwnProductsList, parseListQuery } from './own-products-list.use-case';

// `own-products.list` in memory (catalog design 8.2, 9.2a) on both Market fixtures: the access
// rule, the keyset mode left as it was, the closed list query, the status sets of the tabs, the
// counts, paging and the seller scope. The SQL behaviour is in
// test/db/catalog-seller-reads.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const LISTED = ['draft', 'unpublished', 'published', 'matched', 'retired'];

describe('the closed query of the seller product list', () => {
  const failure = (path: string, code: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });

  it('defaults to the all view, newest change first, 25 a page', () => {
    expect(parseListQuery({ page: 1 })).toEqual({
      ok: true,
      value: {
        view: 'all',
        text: null,
        status: null,
        categoryId: null,
        paused: null,
        typeCode: null,
        sort: 'updated',
        direction: 'desc',
        page: 1,
        pageSize: 25,
      },
    });
  });

  it('sorts by name ascending unless asked otherwise, and trims the search', () => {
    expect(parseListQuery({ sort: 'name', q: '  dates ' })).toMatchObject({
      ok: true,
      value: { sort: 'name', direction: 'asc', text: 'dates' },
    });
    expect(parseListQuery({ sort: 'name', direction: 'desc' })).toMatchObject({
      value: { direction: 'desc' },
    });
    expect(parseListQuery({ q: '   ' })).toMatchObject({ value: { text: null } });
  });

  it('reads Paused as a boolean only', () => {
    expect(parseListQuery({ paused: true })).toMatchObject({ value: { paused: true } });
    expect(parseListQuery({ paused: false })).toMatchObject({ value: { paused: false } });
  });

  it('refuses a malformed query whole, naming the field', () => {
    const bad: [Record<string, unknown>, string, string][] = [
      [{ view: 'live-ish' }, 'view', 'value'],
      [{ view: 'active' }, 'view', 'value'],
      [{ status: 'discarded' }, 'status', 'value'],
      [{ status: 'withdrawn' }, 'status', 'value'],
      [{ status: 'paused' }, 'status', 'value'],
      [{ sort: 'price' }, 'sort', 'value'],
      [{ direction: 'up' }, 'direction', 'value'],
      [{ categoryId: 'nope' }, 'categoryId', 'format'],
      [{ typeCode: 'No Space' }, 'typeCode', 'format'],
      [{ paused: 'true' }, 'paused', 'value'],
      [{ paused: 1 }, 'paused', 'value'],
      [{ q: 'x'.repeat(101) }, 'q', 'length'],
      [{ q: ['a', 'b'] }, 'q', 'length'],
      [{ q: 'a\u0000b' }, 'q', 'format'],
      [{ q: 'a\nb' }, 'q', 'format'],
      [{ page: 0 }, 'page', 'range'],
      [{ page: -1 }, 'page', 'range'],
      [{ page: 1.5 }, 'page', 'range'],
      [{ page: '2' }, 'page', 'range'],
      [{ pageSize: 10 }, 'pageSize', 'range'],
      [{ pageSize: 101 }, 'pageSize', 'range'],
      [{ pageSize: '25' }, 'pageSize', 'range'],
      [{ sellerId: 'x' }, 'sellerId', 'unknown'],
      [{ scope: 'PLATFORM' }, 'scope', 'unknown'],
      // The keyset parameters belong to the other mode.
      [{ page: 1, afterId: 'x' }, 'afterId', 'unknown'],
      [{ page: 1, limit: 5 }, 'limit', 'unknown'],
    ];
    for (const [input, path, code] of bad) {
      expect(parseListQuery(input)).toEqual(failure(path, code));
    }
    expect(parseListQuery([])).toEqual(failure('query', 'type'));
  });

  it('accepts a search of exactly 100 characters, counted as characters', () => {
    expect(parseListQuery({ q: 'x'.repeat(100) }).ok).toBe(true);
    expect(parseListQuery({ q: '\u{1F600}'.repeat(100) }).ok).toBe(true);
  });

  it('allows the three page sizes and stops page numbers at row 10,000', () => {
    for (const pageSize of [25, 50, 100]) {
      expect(parseListQuery({ pageSize }).ok).toBe(true);
      const lastPage = MAX_OWN_LIST_ROWS / pageSize;
      expect(parseListQuery({ pageSize, page: lastPage }).ok).toBe(true);
      expect(parseListQuery({ pageSize, page: lastPage + 1 })).toEqual(failure('page', 'range'));
    }
  });
});

describe.each(['AU', 'ZZ'] as const)('seller products list in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const locale = realPolicy.locales(market).default;

  const sellerContext = (own: Id<'Seller'> = sellerId): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: own,
      }),
    );
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

  const row = (overrides: Partial<OwnProductRow> = {}): OwnProductRow => ({
    productId: ids.next<'Product'>(),
    productCode: 'P00000001',
    typeCode: 'simple',
    status: 'published',
    name: 'Dates',
    draftName: 'Dates',
    primaryImageId: ids.next<'ProductImage'>(),
    categoryId: ids.next<'Category'>(),
    categoryName: 'Fruit',
    offerCount: 2,
    pausedAt: null,
    hasPublishedRevision: true,
    hasPendingRevision: false,
    pendingSubmittedAt: null,
    lastChangedAt: T0,
    createdAt: T0,
    ...overrides,
  });

  function setup(
    options: {
      readonly rows?: readonly OwnProductRow[];
      readonly counts?: readonly number[];
      readonly page?: OwnProductsPageResult;
      readonly allow?: boolean;
      readonly unitFails?: boolean;
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
    const countCalls: {
      market: string;
      sellerId: string;
      filters: readonly OwnProductsFilter[];
    }[] = [];
    const listCalls: {
      market: string;
      sellerId: string;
      filter: OwnProductsFilter;
      order: { sort: string; direction: string };
      page: { offset: number; limit: number };
    }[] = [];
    const keysetCalls: unknown[] = [];
    const ownReader = {
      countProductsBy: (m, s, filters) => {
        countCalls.push({ market: m.marketId, sellerId: s, filters });
        return Promise.resolve(options.counts ?? [9, 3, 4, 2, 1]);
      },
      listProductPage: (m, s, filter, order, page) => {
        listCalls.push({ market: m.marketId, sellerId: s, filter, order, page });
        return Promise.resolve(options.page ?? { kind: 'rows', rows: options.rows ?? [] });
      },
      listProducts: (_m, _s, page) => {
        keysetCalls.push(page);
        return Promise.resolve([]);
      },
      findWorkingCopies: () => Promise.resolve([]),
    } as Partial<OwnCatalogReader> as OwnCatalogReader;
    const useCase = new OwnProductsList(createUseCaseGate(markets, check), {
      unitOfWork,
      ownReader,
      policy: realPolicy,
    });
    return { useCase, checked, units, countCalls, listCalls, keysetCalls };
  }

  it('declares the permission rule under its own name', () => {
    expect(OwnProductsList.access).toEqual({
      name: 'catalog.own-products-list',
      rule: { kind: 'permissions', allOf: ['catalog.own-product.view'] },
      whenSellerNotApproved: 'allow',
    });
  });

  it('asks the gate for the declared rule and reads nothing when it refuses', async () => {
    const { useCase, checked, units } = setup({ allow: false });

    const result = await useCase.execute(sellerContext(), { page: 1 });

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(checked.map((declaration) => declaration.name)).toEqual(['catalog.own-products-list']);
    expect(units).toEqual([]);
  });

  it('refuses a session that is not a seller’s, in either mode', async () => {
    const { useCase, units } = setup();

    for (const input of [{}, { page: 1 }]) {
      expect(await useCase.execute(adminContext(), input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    expect(units).toEqual([]);
  });

  it('keeps the keyset mode as it was when no list parameter is given', async () => {
    const { useCase, keysetCalls, countCalls, listCalls } = setup();

    const result = await useCase.execute(sellerContext(), {});
    const sized = await useCase.execute(sellerContext(), { limit: 5 });

    expect(result).toEqual({ ok: true, value: { items: [], nextAfterId: null } });
    expect(sized.ok).toBe(true);
    // One extra row tells whether another page follows.
    expect(keysetCalls).toEqual([
      { afterId: null, limit: 26 },
      { afterId: null, limit: 6 },
    ]);
    expect(countCalls).toEqual([]);
    expect(listCalls).toEqual([]);
    expect(await useCase.execute(sellerContext(), { limit: 51 })).toMatchObject({
      error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
    });
  });

  it('lists the all view by default, newest change first, in one read-only unit of the Market', async () => {
    const shown = row({
      status: 'published',
      pausedAt: T0,
      hasPendingRevision: true,
      pendingSubmittedAt: T0,
    });
    const { useCase, units, countCalls, listCalls } = setup({ rows: [shown] });

    const result = await useCase.execute(sellerContext(), { page: 1 });

    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            productId: shown.productId,
            productCode: 'P00000001',
            typeCode: 'simple',
            status: 'published',
            draftName: 'Dates',
            name: 'Dates',
            primaryImageId: shown.primaryImageId,
            categoryId: shown.categoryId,
            categoryName: 'Fruit',
            offerCount: 2,
            pausedAt: T0.toString(),
            hasPublishedRevision: true,
            hasPendingRevision: true,
            pendingSubmittedAt: T0.toString(),
            lastChangedAt: T0.toString(),
            createdAt: T0.toString(),
          },
        ],
        total: 9,
        page: 1,
        pageSize: 25,
        counts: { all: 9, drafts: 3, live: 4, inactive: 2, inReview: 1 },
      },
    });
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(countCalls).toHaveLength(1);
    expect(countCalls[0]).toMatchObject({ market: code, sellerId });
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toMatchObject({
      market: code,
      sellerId,
      order: { sort: 'updated', direction: 'desc' },
      page: { offset: 0, limit: 25 },
    });
    // The name is read in the Market's own default locale.
    expect(listCalls[0]!.filter.locale).toBe(locale);
  });

  it('maps each tab to its statuses, and counts all five for the same search', async () => {
    const { useCase, countCalls, listCalls } = setup();

    await useCase.execute(sellerContext(), { view: 'live', q: '  dates ' });
    await useCase.execute(sellerContext(), { view: 'in-review' });

    const filters = countCalls[0]!.filters;
    expect(filters.map((filter) => filter.statuses)).toEqual([
      LISTED,
      ['draft'],
      ['published', 'matched'],
      ['unpublished', 'retired'],
      LISTED,
    ]);
    expect(filters.map((filter) => filter.inReview)).toEqual([false, false, false, false, true]);
    expect(filters.every((filter) => filter.text === 'dates')).toBe(true);
    expect(listCalls[0]!.filter.statuses).toEqual(['published', 'matched']);
    expect(listCalls[1]!.filter).toMatchObject({ statuses: LISTED, inReview: true });
    // A paused product is not an inactive one: Live holds it, Inactive does not.
    for (const call of listCalls) {
      expect(call.filter.statuses).not.toContain('discarded');
      expect(call.filter.statuses).not.toContain('withdrawn');
    }
  });

  it('narrows the tabs by the status filter, down to none', async () => {
    const { useCase, countCalls } = setup({ counts: [4, 0, 4, 0, 1] });

    const result = await useCase.execute(sellerContext(), { view: 'drafts', status: 'published' });

    expect(countCalls[0]!.filters.map((filter) => filter.statuses)).toEqual([
      ['published'],
      [],
      ['published'],
      [],
      ['published'],
    ]);
    expect(result).toMatchObject({ ok: true, value: { total: 0, items: [] } });
  });

  it('passes the filters, sort and page on, and the offset follows the page', async () => {
    const category = ids.next<'Category'>();
    const { useCase, listCalls } = setup({ counts: [200, 0, 120, 0, 0] });

    await useCase.execute(sellerContext(), {
      view: 'live',
      categoryId: category,
      paused: true,
      typeCode: 'simple',
      sort: 'name',
      direction: 'desc',
      page: 3,
      pageSize: 50,
    });

    expect(listCalls[0]).toMatchObject({
      filter: { categoryId: category, paused: true, typeCode: 'simple', text: null },
      order: { sort: 'name', direction: 'desc' },
      page: { offset: 100, limit: 50 },
    });
  });

  it('answers an empty page without a list read when the page is past the end', async () => {
    const { useCase, listCalls } = setup({ counts: [3, 1, 1, 1, 0] });

    const result = await useCase.execute(sellerContext(), { page: 2 });

    expect(result).toMatchObject({ ok: true, value: { items: [], total: 3, page: 2 } });
    expect(listCalls).toEqual([]);
  });

  it('reads only the calling seller’s products, whoever else is in the Market', async () => {
    const other = ids.next<'Seller'>();
    const { useCase, countCalls, listCalls } = setup({ rows: [row()] });

    await useCase.execute(sellerContext(), { page: 1 });
    await useCase.execute(sellerContext(other), { page: 1 });

    expect(countCalls.map((call) => call.sellerId)).toEqual([sellerId, other]);
    expect(listCalls.map((call) => call.sellerId)).toEqual([sellerId, other]);
  });

  it('refuses a malformed list query before any read', async () => {
    const { useCase, units } = setup();

    expect(await useCase.execute(sellerContext(), { page: 1, view: 'x' })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'view', code: 'value' }] },
    });
    expect(
      await useCase.execute(sellerContext(), { pageSize: 25, page: MAX_OWN_LIST_ROWS }),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'page', code: 'range' }] },
    });
    expect(units).toEqual([]);
  });

  it('asks the narrowing for a name sort that matches too many products', async () => {
    const { useCase } = setup({ page: { kind: 'too-broad' } });

    expect(await useCase.execute(sellerContext(), { sort: 'name' })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sort', code: 'too-broad' }] },
    });
  });

  it('answers unavailable when the unit fails', async () => {
    const { useCase } = setup({ unitFails: true });

    expect(await useCase.execute(sellerContext(), { page: 1 })).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });
});
