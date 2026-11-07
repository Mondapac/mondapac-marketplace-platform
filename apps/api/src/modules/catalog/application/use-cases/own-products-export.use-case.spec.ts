import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
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
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';
import {
  OWN_EXPORT_MAX_IDS,
  OWN_EXPORT_MAX_ROWS,
  OwnProductsExport,
  type OwnProductsExportInput,
} from './own-products-export.use-case';

// `own-products.export` in memory (catalog design 9.2c) on both Market fixtures: the access rule,
// the closed query, the columns, the selected rows, the cap, the chunked read, the file cells and
// the seller scope. The SQL behaviour is in test/db/catalog-seller-reads.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const BOM = '﻿';

describe.each(['AU', 'ZZ'] as const)('seller products export in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const locale = realPolicy.locales(market).default;

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
    primaryImageId: null,
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
      /** Every row the reader holds; pages slice it by offset and limit. */
      readonly rows?: readonly OwnProductRow[];
      readonly total?: number;
      readonly tooBroad?: boolean;
      readonly allow?: boolean;
      readonly unitFails?: boolean;
      /** The unit of work with this 1-based number and every later one fails. */
      readonly failFromUnit?: number;
    } = {},
  ) {
    const rows = options.rows ?? [];
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
        const fails =
          options.unitFails === true ||
          (options.failFromUnit !== undefined && units.length >= options.failFromUnit);
        return fails ? Promise.resolve({ ok: false, error: new Error('down') }) : work();
      },
    } as unknown as UnitOfWork;
    const countCalls: { sellerId: string; filters: readonly OwnProductsFilter[] }[] = [];
    const pageCalls: {
      market: string;
      sellerId: string;
      filter: OwnProductsFilter;
      order: { sort: string; direction: string };
      page: { offset: number; limit: number };
    }[] = [];
    const ownReader = {
      countProductsBy: (_m, s, filters) => {
        countCalls.push({ sellerId: s, filters });
        return Promise.resolve([options.total ?? rows.length]);
      },
      listProductPage: (m, s, filter, order, page) => {
        pageCalls.push({ market: m.marketId, sellerId: s, filter, order, page });
        const result: OwnProductsPageResult = options.tooBroad
          ? { kind: 'too-broad' }
          : { kind: 'rows', rows: rows.slice(page.offset, page.offset + page.limit) };
        return Promise.resolve(result);
      },
    } as Partial<OwnCatalogReader> as OwnCatalogReader;
    const xlsxRows: (readonly string[])[] = [];
    const sheetWriter: SheetWriter = {
      xlsx: async function* (name, source) {
        xlsxRows.push([`sheet:${name}`]);
        for await (const cells of source) {
          xlsxRows.push(cells);
          yield new Uint8Array([1]);
        }
      },
    };
    const useCase = new OwnProductsExport(createUseCaseGate(markets, check), {
      unitOfWork,
      ownReader,
      policy: realPolicy,
      sheetWriter,
      clock,
    });
    return { useCase, checked, units, countCalls, pageCalls, xlsxRows };
  }

  async function read(chunks: AsyncIterable<string | Uint8Array>): Promise<string> {
    let text = '';
    for await (const chunk of chunks) text += typeof chunk === 'string' ? chunk : '#';
    return text;
  }

  async function csvOf(useCase: OwnProductsExport, input: OwnProductsExportInput): Promise<string> {
    const result = await useCase.execute(sellerContext(), input);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return read(result.value.chunks);
  }

  const failure = (path: string, fieldCode: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code: fieldCode }] },
  });

  it('declares the permission rule under its own name', () => {
    expect(OwnProductsExport.access).toEqual({
      name: 'catalog.own-products-export',
      rule: { kind: 'permissions', allOf: ['catalog.own-product.view'] },
      whenSellerNotApproved: 'allow',
    });
  });

  it('asks the gate for the declared rule and reads nothing when it refuses', async () => {
    const { useCase, checked, units } = setup({ allow: false });

    const result = await useCase.execute(sellerContext(), {});

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(checked.map((declaration) => declaration.name)).toEqual(['catalog.own-products-export']);
    expect(units).toEqual([]);
  });

  it('refuses a session that is not a seller’s', async () => {
    const { useCase, units } = setup();

    expect(await useCase.execute(adminContext(), {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(units).toEqual([]);
  });

  it('writes a CSV with the default columns, a byte order mark and the day in the name', async () => {
    const { useCase, units, countCalls, pageCalls } = setup({
      rows: [row({ name: 'Dates', productCode: 'P00000007' })],
    });

    const result = await useCase.execute(sellerContext(), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filename).toBe('products-2026-11-07.csv');
    expect(result.value.contentType).toBe('text/csv; charset=utf-8');
    expect(await read(result.value.chunks)).toBe(
      `${BOM}Product,Status,Category,Product code,Last changed\r\n` +
        'Dates,Live,Fruit,P00000007,2026-11-07T00:00:00Z\r\n',
    );
    // The selector is the list's: the all view, newest change first, for the calling seller.
    expect(countCalls).toEqual([
      {
        sellerId,
        filters: [
          {
            statuses: ['draft', 'unpublished', 'published', 'matched', 'retired'],
            inReview: false,
            paused: null,
            categoryId: null,
            typeCode: null,
            text: null,
            locale,
          },
        ],
      },
    ]);
    expect(pageCalls).toEqual([
      {
        market: code,
        sellerId,
        filter: countCalls[0]!.filters[0],
        order: { sort: 'updated', direction: 'desc' },
        page: { offset: 0, limit: 100 },
      },
    ]);
    expect(units.every((unit) => unit.market === code && unit.options?.readOnly === true)).toBe(
      true,
    );
  });

  it('passes the tab, search, filters and order of the list to the reader', async () => {
    const { useCase, pageCalls } = setup({ rows: [row()] });
    const category = ids.next<'Category'>();

    await csvOf(useCase, {
      view: 'live',
      q: ' dates ',
      status: 'published',
      categoryId: category,
      paused: true,
      typeCode: 'simple',
      sort: 'name',
      direction: 'desc',
    });

    expect(pageCalls[0]).toMatchObject({
      sellerId,
      filter: {
        statuses: ['published'],
        inReview: false,
        paused: true,
        categoryId: category,
        typeCode: 'simple',
        text: 'dates',
        locale,
      },
      order: { sort: 'name', direction: 'desc' },
    });
  });

  it('puts the fixed columns first, then the optional ones in the order asked, without duplicates', async () => {
    const { useCase } = setup({ rows: [row({ typeCode: 'bundle', offerCount: 4 })] });

    expect(await csvOf(useCase, { columns: 'type,offers,code,type' })).toBe(
      `${BOM}Product,Status,Category,Product type,Offers,Product code\r\n` +
        'Dates,Live,Fruit,bundle,4,P00000001\r\n',
    );
    expect(await csvOf(useCase, { columns: 'created,category,updated,product,status' })).toBe(
      `${BOM}Product,Status,Category,Created,Last changed\r\n` +
        'Dates,Live,Fruit,2026-11-07T00:00:00Z,2026-11-07T00:00:00Z\r\n',
    );
    expect(await csvOf(useCase, { columns: 'product,status,category' })).toBe(
      `${BOM}Product,Status,Category\r\nDates,Live,Fruit\r\n`,
    );
  });

  it('labels the status and marks a paused product', async () => {
    const { useCase } = setup({
      rows: [
        row({ status: 'draft', name: null, categoryName: null }),
        row({ status: 'published', pausedAt: T0 }),
        row({ status: 'matched' }),
        row({ status: 'unpublished' }),
        row({ status: 'retired' }),
      ],
    });

    const text = await csvOf(useCase, { columns: 'product,status,category' });

    expect(text.split('\r\n').slice(1, 6)).toEqual([
      ',Draft,',
      'Dates,Live (paused),Fruit',
      'Dates,Live,Fruit',
      'Dates,Unpublished,Fruit',
      'Dates,Retired,Fruit',
    ]);
  });

  it('neutralises a formula in a CSV cell and quotes commas, quotes and line breaks', async () => {
    const { useCase } = setup({
      rows: [
        row({ name: '=HYPERLINK("http://x")', categoryName: '@Fruit' }),
        row({ name: '+1', categoryName: 'A, "B"\nC' }),
        row({ name: '-2', categoryName: '\tTab' }),
      ],
    });

    const text = await csvOf(useCase, { columns: 'product,status,category' });

    expect(text).toBe(
      `${BOM}Product,Status,Category\r\n` +
        `"'=HYPERLINK(""http://x"")",Live,'@Fruit\r\n` +
        `'+1,Live,"A, ""B""\nC"\r\n` +
        `'-2,Live,'\tTab\r\n`,
    );
  });

  it('writes an XLSX through the sheet writer with every cell as text', async () => {
    const { useCase, xlsxRows } = setup({
      rows: [row({ name: '=SUM(A1)', offerCount: 12 })],
    });

    const result = await useCase.execute(sellerContext(), {
      format: 'xlsx',
      columns: 'offers,created',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filename).toBe('products-2026-11-07.xlsx');
    expect(result.value.contentType).toBe(XLSX_CONTENT_TYPE);
    await read(result.value.chunks);
    expect(xlsxRows).toEqual([
      ['sheet:Products'],
      ['Product', 'Status', 'Category', 'Offers', 'Created'],
      ['=SUM(A1)', 'Live', 'Fruit', '12', '2026-11-07T00:00:00Z'],
    ]);
  });

  it('reads the products in chunks of 100, each in its own read-only unit', async () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      row({ name: `Product ${index}`, productCode: `P${String(index).padStart(8, '0')}` }),
    );
    const { useCase, units, pageCalls } = setup({ rows: many });

    const text = await csvOf(useCase, { columns: 'product,status,category' });

    expect(text.split('\r\n')).toHaveLength(250 + 2);
    expect(pageCalls.map((call) => call.page)).toEqual([
      { offset: 0, limit: 100 },
      { offset: 100, limit: 100 },
      { offset: 200, limit: 100 },
    ]);
    // One unit for the count and the first chunk, one for each later chunk.
    expect(units).toHaveLength(3);
  });

  it('exports exactly the selected rows, in the order asked, whatever the tab and search', async () => {
    const mine = [row({ name: 'A' }), row({ name: 'B' })];
    const { useCase, countCalls, pageCalls } = setup({ rows: mine });
    const selected = mine.map((product) => product.productId);

    const text = await csvOf(useCase, {
      productIds: selected.join(','),
      view: 'drafts',
      q: 'zzz',
      sort: 'created',
      direction: 'asc',
      columns: 'product',
    });

    expect(text).toBe(`${BOM}Product,Status,Category\r\nA,Live,Fruit\r\nB,Live,Fruit\r\n`);
    const filter = {
      statuses: ['draft', 'unpublished', 'published', 'matched', 'retired'],
      inReview: false,
      paused: null,
      categoryId: null,
      typeCode: null,
      text: null,
      locale,
      productIds: selected,
    };
    expect(countCalls).toEqual([{ sellerId, filters: [filter] }]);
    expect(pageCalls[0]).toMatchObject({ filter, order: { sort: 'created', direction: 'asc' } });
  });

  it('answers product.not-found when a selected id is not a listed product of the seller', async () => {
    // The reader keeps only the seller's products, so a stranger's id lowers the count.
    const { useCase, pageCalls } = setup({ rows: [row()], total: 1 });
    const result = await useCase.execute(sellerContext(), {
      productIds: `${ids.next<'Product'>()},${ids.next<'Product'>()}`,
    });

    expect(result).toEqual({ ok: false, error: { code: 'product.not-found' } });
    expect(pageCalls).toEqual([]);
  });

  it('refuses a bad selection: format, duplicates, too many ids', async () => {
    const { useCase, units } = setup();
    const one = ids.next<'Product'>();

    expect(await useCase.execute(sellerContext(), { productIds: 'nope' })).toEqual(
      failure('productIds', 'format'),
    );
    expect(await useCase.execute(sellerContext(), { productIds: `${one},${one}` })).toEqual(
      failure('productIds', 'duplicate'),
    );
    expect(await useCase.execute(sellerContext(), { productIds: ['a'] })).toEqual(
      failure('productIds', 'type'),
    );
    const tooMany = Array.from({ length: OWN_EXPORT_MAX_IDS + 1 }, () => ids.next<'Product'>());
    expect(await useCase.execute(sellerContext(), { productIds: tooMany.join(',') })).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: OWN_EXPORT_MAX_IDS },
    });
    expect(units).toEqual([]);
  });

  it('accepts exactly the id cap', async () => {
    const selected = Array.from({ length: OWN_EXPORT_MAX_IDS }, () => ids.next<'Product'>());
    const { useCase } = setup({
      rows: selected.map((productId) => row({ productId })),
    });

    const result = await useCase.execute(sellerContext(), {
      productIds: selected.join(','),
      columns: 'product',
    });

    expect(result.ok).toBe(true);
  });

  it('refuses a malformed query whole, naming the field, before any read', async () => {
    const { useCase, units } = setup();
    const bad: [OwnProductsExportInput, string, string][] = [
      [{ format: 'pdf' }, 'format', 'value'],
      [{ format: ['csv'] }, 'format', 'value'],
      [{ columns: 'product,price' }, 'columns', 'value'],
      [{ columns: ['code'] }, 'columns', 'type'],
      [{ view: 'active' }, 'view', 'value'],
      [{ status: 'withdrawn' }, 'status', 'value'],
      [{ sort: 'price' }, 'sort', 'value'],
      [{ direction: 'up' }, 'direction', 'value'],
      [{ categoryId: 'nope' }, 'categoryId', 'format'],
      [{ paused: 'true' }, 'paused', 'value'],
      [{ q: 'x'.repeat(101) }, 'q', 'length'],
      [{ typeCode: 'No Space' }, 'typeCode', 'format'],
      [{ page: 1 }, 'page', 'unknown'],
      [{ pageSize: 25 }, 'pageSize', 'unknown'],
      [{ afterId: 'x' }, 'afterId', 'unknown'],
      [{ limit: 5 }, 'limit', 'unknown'],
      [{ sellerId: 'x' }, 'sellerId', 'unknown'],
      [{ scope: 'PLATFORM' }, 'scope', 'unknown'],
      [{ ids: 'x' }, 'ids', 'unknown'],
    ];
    for (const [input, path, fieldCode] of bad) {
      expect(await useCase.execute(sellerContext(), input)).toEqual(failure(path, fieldCode));
    }
    expect(await useCase.execute(sellerContext(), [] as unknown as OwnProductsExportInput)).toEqual(
      failure('query', 'type'),
    );
    expect(units).toEqual([]);
  });

  it('refuses more than the row cap whole, with the total, and writes nothing', async () => {
    const { useCase, pageCalls } = setup({ total: OWN_EXPORT_MAX_ROWS + 1 });

    expect(await useCase.execute(sellerContext(), {})).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: OWN_EXPORT_MAX_ROWS, total: OWN_EXPORT_MAX_ROWS + 1 },
    });
    expect(pageCalls).toEqual([]);
  });

  it('exports exactly the row cap', async () => {
    const { useCase, pageCalls } = setup({
      rows: Array.from({ length: OWN_EXPORT_MAX_ROWS }, () => row()),
    });

    const text = await csvOf(useCase, { columns: 'product' });

    expect(text.split('\r\n')).toHaveLength(OWN_EXPORT_MAX_ROWS + 2);
    expect(pageCalls).toHaveLength(OWN_EXPORT_MAX_ROWS / 100);
  });

  it('refuses a name sort over too many matches before the status line, as the list does', async () => {
    const { useCase } = setup({ rows: [row()], tooBroad: true });

    expect(await useCase.execute(sellerContext(), { sort: 'name' })).toEqual(
      failure('sort', 'too-broad'),
    );
  });

  it('answers an empty file with the header only when nothing matches', async () => {
    const { useCase } = setup({ rows: [] });

    expect(await csvOf(useCase, {})).toBe(
      `${BOM}Product,Status,Category,Product code,Last changed\r\n`,
    );
  });

  it('answers access.unavailable when the read fails', async () => {
    expect(await setup({ unitFails: true }).useCase.execute(sellerContext(), {})).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });

  it('fails the stream, not the answer, when a later chunk cannot be read', async () => {
    const { useCase } = setup({ rows: Array.from({ length: 150 }, () => row()), failFromUnit: 2 });

    const result = await useCase.execute(sellerContext(), { columns: 'product' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(read(result.value.chunks)).rejects.toThrow('the read failed');
  });
});
