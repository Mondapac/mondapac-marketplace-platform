import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { brandState, MemoryBrands } from '../../../../../test/support/catalog-brand-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AccessDeclaration, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { SheetWriter } from '../../../../platform/list-export';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { BrandPageQuery } from '../ports/brand.reader';
import { BRAND_EXPORT_MAX_IDS, BRAND_EXPORT_MAX_ROWS, BrandExport } from './brand-export.use-case';

// `brand.export` in memory, on both Market fixtures: the access rule, the closed query, the filter
// shared with the list (status, q, sort, direction), the selected ids, the cap and both formats.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-19T03:00:00Z');

const brandId = (n: number): Id<'Brand'> =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Brand'>;

async function text(chunks: AsyncIterable<string | Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of chunks) out += typeof chunk === 'string' ? chunk : '<bytes>';
  return out;
}

describe.each(['AU', 'ZZ'] as const)('brand export in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));

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

  function setup(options: { readonly allow?: boolean; readonly unitFails?: boolean } = {}) {
    const brands = new MemoryBrands();
    brands.seed(brandState(brandId(1), 'Acme Tea', { originCountry: 'AU' }));
    brands.seed(brandState(brandId(2), '=Formula Foods', { summary: 'Sweet' }));
    brands.seed(brandState(brandId(3), 'Draft Brand', { status: 'draft' }));
    brands.seed(brandState(brandId(4), 'Old Brand', { status: 'archived' }));
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
    const pages: BrandPageQuery[] = [];
    const page = brands.page.bind(brands);
    brands.page = (m, query) => {
      pages.push(query);
      return page(m, query);
    };
    const sheets: { name: string; rows: string[][] }[] = [];
    const sheetWriter: SheetWriter = {
      xlsx: async function* (name, rows) {
        const sheet = { name, rows: [] as string[][] };
        sheets.push(sheet);
        for await (const row of rows) sheet.rows.push([...row]);
        yield new Uint8Array([1]);
      },
    };
    const useCase = new BrandExport(createUseCaseGate(markets, check), {
      unitOfWork,
      brandReader: brands,
      sheetWriter,
      clock: new FixedClock(T0),
    });
    return { useCase, brands, checked, units, pages, sheets };
  }

  it('declares the list read rule under its own name', () => {
    expect(BrandExport.access).toEqual({
      name: 'catalog.brand-export',
      rule: { kind: 'permissions', allOf: ['catalog.brand.read'] },
    });
  });

  it('reads nothing when the gate refuses, and refuses a seller session', async () => {
    const refused = setup({ allow: false });
    expect(await refused.useCase.execute(contextOf('admin'), {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(refused.checked.map((d) => d.name)).toEqual(['catalog.brand-export']);
    expect(refused.units).toEqual([]);

    const { useCase, units } = setup();
    expect(await useCase.execute(contextOf('seller'), {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(units).toEqual([]);
  });

  it('exports what the filter matches as CSV, sorted as asked, in one read-only unit', async () => {
    const { useCase, units, pages } = setup();

    const result = await useCase.execute(contextOf('admin'), {
      status: 'active',
      q: ' a ',
      sort: 'name',
      direction: 'desc',
      columns: 'id,summary',
    });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.filename).toBe('brands-2026-11-19.csv');
    expect(result.value.contentType).toBe('text/csv; charset=utf-8');
    const csv = await text(result.value.chunks);
    const lines = csv
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]).toBe('Brand,Slug,Status,Origin country,Last changed,Brand id,Summary');
    // Descending by name; the formula-looking name gets a leading quote.
    expect(lines.slice(1)).toEqual([
      `Acme Tea,acme-tea,Active,AU,2026-10-28T00:00:00Z,${brandId(1)},`,
      `'=Formula Foods,formula-foods,Active,,2026-10-28T00:00:00Z,${brandId(2)},Sweet`,
    ]);
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(pages).toEqual([
      {
        status: 'active',
        search: 'a',
        sort: 'name',
        direction: 'desc',
        offset: 0,
        limit: BRAND_EXPORT_MAX_ROWS + 1,
      },
    ]);
  });

  it('exports the selected ids in the order given as XLSX, every status', async () => {
    const { useCase, sheets, pages } = setup();

    const result = await useCase.execute(contextOf('admin'), {
      format: 'xlsx',
      ids: `${brandId(4)},${brandId(1)}`,
    });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.filename).toBe('brands-2026-11-19.xlsx');
    await text(result.value.chunks);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe('Brands');
    expect(sheets[0]!.rows.map((row) => row[0])).toEqual(['Brand', 'Old Brand', 'Acme Tea']);
    expect(sheets[0]!.rows[1]![2]).toBe('Archived');
    expect(pages).toEqual([]);
  });

  it('refuses the whole request when one selected id is no brand', async () => {
    const { useCase } = setup();
    expect(
      await useCase.execute(contextOf('admin'), { ids: `${brandId(1)},${brandId(99)}` }),
    ).toEqual({ ok: false, error: { code: 'brand.not-found' } });
  });

  it('refuses too many ids, a malformed or repeated id', async () => {
    const { useCase } = setup();
    const many = Array.from({ length: BRAND_EXPORT_MAX_IDS + 1 }, (_, n) => brandId(n + 1000));
    expect(await useCase.execute(contextOf('admin'), { ids: many.join(',') })).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: BRAND_EXPORT_MAX_IDS },
    });
    expect(await useCase.execute(contextOf('admin'), { ids: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'ids', code: 'format' }] },
    });
    expect(
      await useCase.execute(contextOf('admin'), { ids: `${brandId(1)},${brandId(1)}` }),
    ).toMatchObject({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'ids', code: 'duplicate' }] },
    });
  });

  it('refuses a match over the cap whole, with the total', async () => {
    const { useCase, brands } = setup();
    for (let n = 0; n < BRAND_EXPORT_MAX_ROWS; n += 1) {
      brands.seed(brandState(brandId(10_000 + n), `Bulk ${n}`));
    }
    const result = await useCase.execute(contextOf('admin'), {});
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'batch.too-large',
        max: BRAND_EXPORT_MAX_ROWS,
        total: BRAND_EXPORT_MAX_ROWS + 4,
      },
    });
  });

  it.each([
    [{ status: 'gone' }, 'status', 'unknown'],
    [{ q: 'a\u0007b' }, 'q', 'format'],
    [{ q: 'x', search: 'y' }, 'search', 'conflict'],
    [{ sort: 'origin' }, 'sort', 'value'],
    [{ direction: 'up' }, 'direction', 'value'],
    [{ format: 'pdf' }, 'format', 'value'],
    [{ columns: 'logo' }, 'columns', 'value'],
    [{ page: '2' }, 'page', 'unknown'],
  ])('refuses %j as validation.failed', async (input, path, reason) => {
    const { useCase, units } = setup();
    expect(await useCase.execute(contextOf('admin'), input)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: reason }] },
    });
    expect(units).toEqual([]);
  });

  it('answers access.unavailable when the read fails', async () => {
    const { useCase } = setup({ unitFails: true });
    expect(await useCase.execute(contextOf('admin'), {})).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });
});
