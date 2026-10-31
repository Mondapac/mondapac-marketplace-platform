import { parseId, Temporal } from '@mondapac/shared-kernel';
import type {
  AttributeField,
  CallContext,
  Id,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
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
import type { StoredCategoryNode } from '../../domain/category-tree';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import type { ImportRowRecord } from '../../domain/platform-import/platform-import-job';
import type { RateReservation } from '../../domain/rate-limits';
import { configurableProductType } from '../../domain/product-types/configurable';
import { simpleProductType } from '../../domain/product-types/simple';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ImportFileStore } from '../ports/import-file-store';
import type { NewImportJob, PlatformImportRepository } from '../ports/platform-import.repository';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import { PlatformImportCheck } from './platform-import-check.use-case';

// `platform-import.check` in memory on both Market fixtures (catalog design 14a): what a check
// stores and, as important, what it never touches. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');

const categoryId = (n: number): Id<'Category'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Category'>;
};

const field = (code: string, required: boolean): AttributeField => ({
  code,
  dataType: 'text',
  localizable: false,
  required,
  isVariantOption: false,
  material: false,
  claimChecked: true,
  bounds: {},
});

const HEADER =
  'Title,Main category,Product type,Description,Brand,Barcode (GTIN),Unit size,Image URL';
const csv = (...rows: string[]): string =>
  Buffer.from([HEADER, ...rows].join('\n')).toString('base64');

describe.each(['AU', 'ZZ'] as const)('platform-import.check in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locale = policy.locales(market).default;

  function rig(options: { counts?: number } = {}) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const jobs: NewImportJob[] = [];
    const rows: ImportRowRecord[] = [];
    const files = new Map<string, Uint8Array>();
    const reserved: string[] = [];
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const importJobs = {
      add: (_m: MarketContext, job: NewImportJob, list: readonly ImportRowRecord[]) => {
        jobs.push(job);
        rows.push(...list);
        return Promise.resolve();
      },
      discardChecked: () => Promise.resolve([]),
    } as unknown as PlatformImportRepository;
    const importFiles: ImportFileStore = {
      keyOf: (m, id) => `catalog/imports/${m.marketId}/${id}`,
      put: (key, bytes) => {
        files.set(key, bytes);
        return Promise.resolve();
      },
      get: (key) => Promise.resolve(files.get(key) ?? null),
      delete: (key) => {
        files.delete(key);
        return Promise.resolve();
      },
    };
    const counters: RateCounterRepository = {
      reserve: (_m, list, now): Promise<readonly RateReservation[]> => {
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
    };
    const nodes: StoredCategoryNode[] = [
      {
        id: categoryId(1),
        parentId: null,
        status: 'active',
        mergedIntoId: null,
        slug: 'meat',
        names: [{ locale, name: 'Meat' }],
      },
    ];
    const treeReader = { nodes: () => Promise.resolve(nodes) } as unknown as CategoryTreeReader;
    const attributes = {
      loadSchema: () =>
        Promise.resolve({
          schemaRef: {
            familyCode: 'default',
            familyRevisionId: 'r' as Id,
            definitionRevisionIds: [],
          },
          fields: [field('brand', true)],
        }),
    } as unknown as AttributeRepository;
    const handlers = { simple: simpleProductType, configurable: configurableProductType };
    const useCase = new PlatformImportCheck(gate, {
      unitOfWork,
      importJobs,
      importFiles,
      counters,
      counterKeys: { keyOf: () => new Uint8Array(32) },
      clock,
      ids,
      treeReader,
      attributes,
      policy,
      productTypes: (typeCode) => handlers[typeCode as keyof typeof handlers],
    });
    return { useCase, jobs, rows, files, reserved, ids };
  }

  const contextOf = (
    population: 'admin' | 'seller' | 'customer',
    ids: SequenceIdGenerator,
  ): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );

  it('checks the rows, stores the file and the job, and writes no product', async () => {
    const r = rig();
    const result = await r.useCase.execute(contextOf('admin', r.ids), {
      fileName: 'C:\\temp\\<new>.csv',
      data: csv(
        'Lamb,Meat,simple,Shoulder,Farms,,1 kg,',
        ',Meat,simple,,Farms,,,',
        'Beef,Nowhere,simple,,Farms,,,',
      ),
    });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({ rows: 3, ready: 1, errors: 2, state: 'checked' });
    expect(result.value.fileLabel).not.toMatch(/[<>\\]/);
    expect(r.jobs).toHaveLength(1);
    expect(r.rows.map((row) => [row.rowNumber, row.checkState, row.runState])).toEqual([
      [2, 'ready', 'pending'],
      [3, 'error', 'skipped'],
      [4, 'error', 'skipped'],
    ]);
    expect([...r.files.keys()]).toEqual([r.jobs[0]!.fileKey]);
    expect(r.jobs[0]!.fileKey).toContain(`catalog/imports/${code}/`);
    expect(r.reserved.length).toBeGreaterThan(0);
  });

  it('lists a certification column as ignored and stores nothing of it', async () => {
    const r = rig();
    const data = Buffer.from(
      `${HEADER},Halal certified\nLamb,Meat,simple,,Farms,,,,yes\n`,
    ).toString('base64');
    const result = await r.useCase.execute(contextOf('admin', r.ids), { fileName: 'a.csv', data });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.ignoredColumns).toEqual([
      { header: 'Halal certified', certification: true },
    ]);
    expect(JSON.stringify(r.rows)).not.toContain('yes');
  });

  it.each([
    ['an empty body', { fileName: 'a.csv', data: '' }, 'validation.failed'],
    ['a name that is not text', { fileName: 7, data: 'QQ==' }, 'validation.failed'],
    ['data that is not base64', { fileName: 'a.csv', data: '@@@@' }, 'validation.failed'],
    ['no data', { fileName: 'a.csv' }, 'validation.failed'],
  ])('refuses %s without storing anything', async (_label, input, expected) => {
    const r = rig();
    const result = await r.useCase.execute(contextOf('admin', r.ids), input);
    expect(result.ok ? 'ok' : result.error.code).toBe(expected);
    expect(r.jobs).toHaveLength(0);
    expect(r.files.size).toBe(0);
  });

  it('refuses a file that is too large from the length of the text, before decoding it', async () => {
    const r = rig();
    const result = await r.useCase.execute(contextOf('admin', r.ids), {
      fileName: 'a.csv',
      data: 'A'.repeat(Math.ceil((IMPORT_LIMITS.fileBytes * 4) / 3) + 8),
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.too-large', maxBytes: IMPORT_LIMITS.fileBytes },
    });
    expect(r.reserved).toHaveLength(0);
  });

  it('refuses an XLSX by its content, whatever the name says', async () => {
    const r = rig();
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).toString('base64');
    const result = await r.useCase.execute(contextOf('admin', r.ids), {
      fileName: 'a.csv',
      data: zip,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.unsupported-type', detected: 'xlsx' },
    });
    expect(r.jobs).toHaveLength(0);
  });

  it('refuses columns that do not match', async () => {
    const r = rig();
    const data = Buffer.from('Name,Colour\nA,B\n').toString('base64');
    const result = await r.useCase.execute(contextOf('admin', r.ids), { fileName: 'a.csv', data });
    expect(result.ok ? 'ok' : result.error.code).toBe('columns.missing');
  });

  it('throttles an admin over the hourly count before reading the file', async () => {
    const r = rig({ counts: 1000 });
    const result = await r.useCase.execute(contextOf('admin', r.ids), {
      fileName: 'a.csv',
      data: csv('Lamb,Meat,simple,,Farms,,,'),
    });
    expect(result.ok ? 'ok' : result.error.code).toBe('request.throttled');
    expect(r.jobs).toHaveLength(0);
  });

  it.each(['seller', 'customer'] as const)('is not for a %s', async (population) => {
    const r = rig();
    const result = await r.useCase.execute(contextOf(population, r.ids), {
      fileName: 'a.csv',
      data: csv('Lamb,Meat,simple,,Farms,,,'),
    });
    expect(result.ok).toBe(false);
    expect(r.jobs).toHaveLength(0);
  });
});
