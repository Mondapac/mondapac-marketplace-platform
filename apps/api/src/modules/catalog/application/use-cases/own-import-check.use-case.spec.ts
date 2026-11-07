import { createHash } from 'node:crypto';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  contentTypesXml,
  MAIN_TYPE,
  workbookBytes,
  workbookSkeleton,
  zipOf,
} from '../../../../../test/support/zip-fixtures';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { StoredCategoryNode } from '../../domain/category-tree';
import {
  csvParser,
  isZipContainer,
  readImportFile,
  type ImportFileParser,
} from '../../domain/platform-import/import-file';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { simpleProductType } from '../../domain/product-types/simple';
import type { SellerRowRecord } from '../../domain/seller-import/seller-import-job';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { xlsxParser } from '../../infrastructure/xlsx/isolated-xlsx-parser';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { ImportFileStore } from '../ports/import-file-store';
import type { NewSellerImportJob, SellerImportRepository } from '../ports/seller-import.repository';
import { OwnImportCheck, type OwnImportCheckInput } from './own-import-check.use-case';

// `own-import.check` in memory on both Market fixtures (catalog design 14c): what a check stores and
// what it never touches, in both modes, and the 14a file parser and XLSX safeguard fixtures run on
// the seller route (shared parsers). The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const categoryId = (n: number): Id<'Category'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Category'>;
};

describe.each(['AU', 'ZZ'] as const)('own-import.check in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locale = policy.locales(market).default;
  const condition = policy.conditions(market)[0]!;
  const HEADER =
    'Seller SKU,Condition,Title,Main category,Product type,Price,Stock,Halal certified';
  const csv = (...rows: string[]): string =>
    Buffer.from([HEADER, ...rows].join('\n')).toString('base64');

  interface Options {
    readonly counts?: number;
    readonly parsers?: readonly ImportFileParser[];
    readonly eligible?: boolean;
    readonly productCreation?: boolean;
    readonly sellFromCatalogue?: boolean;
    readonly existing?: boolean;
    readonly storeFails?: boolean;
  }

  function rig(options: Options = {}) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const jobs: NewSellerImportJob[] = [];
    const rows: SellerRowRecord[] = [];
    const files = new Map<string, Buffer>();
    const reserved: string[] = [];
    const discarded: string[] = [];
    const sellerId = ids.next<'Seller'>();
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const sellerJobs = {
      add: (_m: MarketContext, job: NewSellerImportJob, list: readonly SellerRowRecord[]) => {
        jobs.push(job);
        rows.push(...list);
        return Promise.resolve();
      },
      discardChecked: (_m: unknown, seller: string) => {
        discarded.push(seller);
        return Promise.resolve([]);
      },
    } as unknown as SellerImportRepository;
    const importFiles: ImportFileStore = {
      keyOf: (m, id) => `catalog/seller-imports/${m.marketId}/${id}`,
      put: (key, bytes) => {
        if (options.storeFails === true) return Promise.reject(new Error('store down'));
        files.set(key, bytes);
        return Promise.resolve();
      },
      get: (key) => Promise.resolve(files.get(key) ?? null),
      delete: (key) => {
        files.delete(key);
        return Promise.resolve();
      },
    };
    const nodes: StoredCategoryNode[] = [
      {
        id: categoryId(1),
        parentId: null,
        status: 'active',
        mergedIntoId: null,
        slug: 'meat',
        position: 0,
        names: [{ locale, name: 'Meat' }],
      },
    ];
    const policyOverride = Object.create(policy) as ConfigCatalogMarketPolicy;
    policyOverride.sellerCanCreateProduct = () =>
      Promise.resolve(options.productCreation !== false);
    policyOverride.sellFromCatalogue = () => Promise.resolve(options.sellFromCatalogue !== false);
    const useCase = new OwnImportCheck(gate, {
      unitOfWork,
      sellerJobs,
      importFiles,
      importParsers: options.parsers ?? [csvParser],
      counters: {
        reserve: (
          _m: MarketContext,
          list: readonly { limit: { kind: string } }[],
          now: Temporal.Instant,
        ) => {
          for (const counter of list) reserved.push(counter.limit.kind);
          return Promise.resolve(
            list.map((counter) => ({
              kind: counter.limit.kind,
              count: options.counts ?? 1,
              windowStartedAt: now,
            })),
          );
        },
        purgeStartedBefore: () => Promise.resolve(0),
      } as never,
      counterKeys: { keyOf: () => new Uint8Array(32) } as never,
      importFacts: {
        load: () =>
          Promise.resolve({
            offersBySku: new Map(),
            ownSkuByProductId: new Map(),
            catalogueByCode: new Map(),
          }),
      },
      eligibility: { isEligible: () => Promise.resolve(options.eligible !== false) },
      allowedTypes: { allowedFor: () => Promise.resolve('all') },
      clock,
      ids,
      treeReader: { nodes: () => Promise.resolve(nodes) },
      attributes: {
        loadSchema: () =>
          Promise.resolve({
            schemaRef: {
              familyCode: 'default',
              familyRevisionId: 'r' as Id,
              definitionRevisionIds: [],
            },
            fields: [],
          }),
      } as unknown as AttributeRepository,
      policy: policyOverride,
      productTypes: (typeCode) => (typeCode === 'simple' ? simpleProductType : undefined),
    });
    const context = (population: 'seller' | 'admin' | 'customer' = 'seller'): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: population === 'seller' ? sellerId : null,
        }),
      );
    return { useCase, jobs, rows, files, reserved, discarded, context, sellerId };
  }
  const row = (n: number, over = ''): string =>
    `SKU-${n},${condition},Lamb ${n},Meat,simple,9.99,5,yes${over}`;
  const mine = (data: string, fileName = 'a.csv'): OwnImportCheckInput => ({
    mode: 'my-products',
    fileName,
    data,
  });

  it('checks the rows, stores the file and the job, discards the earlier check and writes no product', async () => {
    const r = rig();
    const result = await r.useCase.execute(
      r.context(),
      mine(csv(row(1), `SKU-2,${condition},,Meat,simple,1,1,no`), 'C:\\temp\\<new>.csv'),
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({ rows: 2, ready: 1, errors: 1, state: 'checked' });
    expect(result.value.fileLabel).not.toMatch(/[<>\\]/);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({ sellerId: r.sellerId, mode: 'my-products' });
    expect(r.discarded).toEqual([r.sellerId]);
    expect(r.rows.map((x) => [x.rowNumber, x.checkState, x.runState])).toEqual([
      [2, 'ready', 'pending'],
      [3, 'error', 'skipped'],
    ]);
    expect([...r.files.keys()]).toEqual([r.jobs[0]!.fileKey]);
    expect(r.jobs[0]!.fileKey).toContain(`catalog/seller-imports/${code}/`);
    // The hourly and the daily count of the seller are both spent.
    expect(r.reserved.sort()).toEqual([
      'seller-import-check.seller.day',
      'seller-import-check.seller.hour',
    ]);
  });

  it('lists the certification, price and stock columns as ignored and keeps none of their cells', async () => {
    const r = rig();
    const result = await r.useCase.execute(r.context(), mine(csv(row(1))));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.ignoredColumns.map((column) => column.header).sort()).toEqual([
      'Halal certified',
      'Price',
      'Stock',
    ]);
    const stored = JSON.stringify([r.rows, r.jobs]);
    expect(stored).not.toContain('9.99');
    expect(stored).not.toContain('yes');
  });

  it('refuses a mode the Market has switched off, before the file is read', async () => {
    const off = rig({ productCreation: false });
    expect(await off.useCase.execute(off.context(), mine(csv(row(1))))).toEqual({
      ok: false,
      error: { code: 'setting.product-creation-off' },
    });
    const catalogueOff = rig({ sellFromCatalogue: false });
    expect(
      await catalogueOff.useCase.execute(catalogueOff.context(), {
        mode: 'sell-from-catalogue',
        fileName: 'a.csv',
        data: Buffer.from('Seller SKU,Product code\nA,P1').toString('base64'),
      }),
    ).toEqual({ ok: false, error: { code: 'setting.sell-from-catalogue-off' } });
    expect([...off.jobs, ...catalogueOff.jobs]).toHaveLength(0);
    expect(off.reserved).toHaveLength(0);
  });

  it('checks a sell-from-catalogue file against the catalogue and answers an unknown code as an error row', async () => {
    const r = rig();
    const result = await r.useCase.execute(r.context(), {
      mode: 'sell-from-catalogue',
      fileName: 'a.csv',
      data: Buffer.from(`Seller SKU,Condition,Product code\nA,${condition},NOSUCH1`).toString(
        'base64',
      ),
    });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({ rows: 1, ready: 0, errors: 1 });
    expect(r.rows[0]!.issues[0]).toMatchObject({ code: 'product.not-found' });
  });

  it.each([
    ['an empty body', mine('')],
    ['a mode that is neither', { mode: 'both', fileName: 'a.csv', data: 'QQ==' }],
    ['a name that is not text', { mode: 'my-products', fileName: 7, data: 'QQ==' }],
    ['data that is not base64', mine('@@@@')],
  ])('refuses %s without storing anything', async (_label, input) => {
    const r = rig();
    const result = await r.useCase.execute(r.context(), input as OwnImportCheckInput);
    expect(result.ok ? 'ok' : result.error.code).toBe('validation.failed');
    expect(r.jobs).toHaveLength(0);
    expect(r.files.size).toBe(0);
  });

  it('refuses a seller who may not sell, an admin, a customer and a throttled seller', async () => {
    const notEligible = rig({ eligible: false });
    expect(await notEligible.useCase.execute(notEligible.context(), mine(csv(row(1))))).toEqual({
      ok: false,
      error: { code: 'seller.not-eligible' },
    });
    for (const population of ['admin', 'customer'] as const) {
      const r = rig();
      expect(await r.useCase.execute(r.context(population), mine(csv(row(1))))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    const throttled = rig({ counts: 1000 });
    expect((await throttled.useCase.execute(throttled.context(), mine(csv(row(1))))).ok).toBe(
      false,
    );
    expect(throttled.jobs).toHaveLength(0);
  });

  it('answers access.unavailable and keeps no file when the store cannot take it', async () => {
    const r = rig({ storeFails: true });
    expect(await r.useCase.execute(r.context(), mine(csv(row(1))))).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(r.jobs).toHaveLength(0);
  });

  describe('the 14a file safeguards, on the seller route', () => {
    const base64OfZip = (zip: Buffer): OwnImportCheckInput =>
      mine(zip.toString('base64'), 'a.xlsx');
    const refusal = async (data: OwnImportCheckInput, parsers = [csvParser, xlsxParser]) => {
      const r = rig({ parsers });
      const result = await r.useCase.execute(r.context(), data);
      expect(r.jobs).toHaveLength(0);
      expect(r.files.size).toBe(0);
      return result.ok ? null : result.error;
    };

    it('refuses a file that is too large from the length of the text, before decoding it', async () => {
      const r = rig();
      const result = await r.useCase.execute(
        r.context(),
        mine('A'.repeat(Math.ceil((IMPORT_LIMITS.fileBytes * 4) / 3) + 8)),
      );
      expect(result).toEqual({
        ok: false,
        error: { code: 'file.too-large', maxBytes: IMPORT_LIMITS.fileBytes },
      });
      expect(r.reserved).toHaveLength(0);
    });

    it('refuses an XLSX by its content when the XLSX reader is not asked, whatever the name says', async () => {
      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).toString('base64');
      expect(await refusal(mine(zip, 'a.csv'), [csvParser])).toEqual({
        code: 'file.unsupported-type',
        detected: 'xlsx',
      });
    });

    it('checks an XLSX like a CSV, stores it as plain CSV and records its format', async () => {
      const r = rig({ parsers: [csvParser, xlsxParser] });
      const bytes = await workbookBytes([
        ['Seller SKU', 'Condition', 'Title', 'Main category', 'Product type'],
        ['SKU-1', condition, 'Lamb', 'Meat', 'simple'],
        ['SKU-2', condition, '', 'Meat', 'simple'],
      ]);
      const result = await r.useCase.execute(r.context(), mine(bytes.toString('base64'), 'a.xlsx'));
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value).toMatchObject({ rows: 2, ready: 1, errors: 1 });
      expect(r.jobs[0]!.format).toBe('xlsx');
      const stored = r.files.get(r.jobs[0]!.fileKey)!;
      // The workbook is opened once, here: what is stored is its table as plain CSV.
      expect(isZipContainer(stored)).toBe(false);
      expect(r.jobs[0]!.fileSha256).toBe(createHash('sha256').update(stored).digest('hex'));
      const again = await readImportFile(stored, IMPORT_LIMITS, [csvParser]);
      expect(again.ok && again.value.rows.map((x) => x.rowNumber)).toEqual([2, 3]);
    });

    it('refuses a formula cell, naming the row', async () => {
      const bytes = await workbookBytes([
        ['Seller SKU', 'Condition', 'Title', 'Main category', 'Product type'],
        ['SKU-1', condition, 'Lamb', { formula: '"Meat"', result: 'Meat' }, 'simple'],
      ]);
      expect(await refusal(base64OfZip(bytes))).toEqual({
        code: 'file.formula-cell',
        rowNumber: 2,
      });
    });

    it('refuses a zip bomb, a suspicious ratio, a macro project, an external link and the wrong type', async () => {
      const bomb = zipOf([
        ...workbookSkeleton(),
        {
          name: 'xl/worksheets/sheet1.xml',
          data: Buffer.alloc(IMPORT_LIMITS.decompressedBytes + 1024 * 1024),
        },
      ]);
      expect(await refusal(base64OfZip(bomb))).toEqual({
        code: 'file.unpacked-too-large',
        maxBytes: IMPORT_LIMITS.decompressedBytes,
      });
      const dense = zipOf([
        ...workbookSkeleton(),
        { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(8 * 1024 * 1024) },
      ]);
      expect(await refusal(base64OfZip(dense))).toEqual({
        code: 'file.unpacked-too-large',
        maxBytes: IMPORT_LIMITS.decompressedBytes,
      });
      for (const name of ['xl/vbaProject.bin', 'xl/externalLinks/externalLink1.xml']) {
        const zip = zipOf([...workbookSkeleton(), { name, data: Buffer.from('x') }]);
        expect(await refusal(base64OfZip(zip))).toEqual({
          code: 'file.unsupported-type',
          detected: 'other',
        });
      }
      const macro = zipOf(workbookSkeleton('application/vnd.ms-excel.sheet.macroEnabled.main+xml'));
      expect(await refusal(base64OfZip(macro))).toEqual({
        code: 'file.unsupported-type',
        detected: 'other',
      });
      const dtd = zipOf([
        { name: '[Content_Types].xml', data: contentTypesXml(MAIN_TYPE) },
        {
          name: 'xl/workbook.xml',
          data: Buffer.from('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><workbook/>'),
        },
      ]);
      expect((await refusal(base64OfZip(dtd)))?.code).toBe('file.unsupported-type');
    });

    it('refuses columns that do not match the mode', async () => {
      const result = await refusal(mine(Buffer.from('Name,Colour\nA,B\n').toString('base64')));
      expect(result?.code).toBe('columns.missing');
    });
  });
});
