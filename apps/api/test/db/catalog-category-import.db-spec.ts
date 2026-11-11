import { err, ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { CSV_BOM, csvLine } from '@mondapac/platform-import';
import { Client } from 'pg';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { ContentFilter } from '../../src/platform/content-filter/content-filter';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { CategoryImportDependencies } from '../../src/modules/catalog/application/categories/category-import';
import { CategoryImportApply } from '../../src/modules/catalog/application/use-cases/category-import-apply.use-case';
import { CategoryImportDryRun } from '../../src/modules/catalog/application/use-cases/category-import-dry-run.use-case';
import {
  CategoryTreeExport,
  exportHeader,
} from '../../src/modules/catalog/application/use-cases/category-tree-export.use-case';
import { IMPORT_PARSERS } from '../../src/modules/catalog/domain/platform-import/import-file';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { ExceljsSheetWriter } from '../../src/modules/catalog/infrastructure/xlsx/exceljs-sheet-writer';
import { xlsxParser } from '../../src/modules/catalog/infrastructure/xlsx/isolated-xlsx-parser';
import { PrismaAdminCategoryReader } from '../../src/modules/catalog/infrastructure/prisma-admin-category.reader';
import { PrismaCategoryEditStore } from '../../src/modules/catalog/infrastructure/prisma-category-edit.store';
import { PrismaPlatformCategoryRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-category.repository';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The category tree import on PostgreSQL, for both Market fixtures (categories package C7a): a
// file creates a parent and children in one unit with one tree version raise (the children get the
// next positions among their siblings), the export reads back as all unchanged, a changed cell is
// an update with a new revision, a stale tree version writes nothing, and the other Market sees
// none of it. The use cases are in category-import.use-cases.spec.ts.

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ADMIN = uuid7() as Id<'Account'>;

describe.each(TEST_MARKETS)('catalog category import in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let store: PrismaCategoryEditStore;
  let categories: PrismaPlatformCategoryRepository;
  let audits: AuditEntry[];
  let events: PendingEvent[];
  let deps: CategoryImportDependencies;
  let gateOf: () => ReturnType<typeof createUseCaseGate>;
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const policy = new ConfigCatalogMarketPolicy(markets);
  const locales = policy.locales(market);
  const header = exportHeader([...locales.supported].sort());
  const nameColumn = `name[${locales.default}]`;

  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: null,
      }),
    );

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaCategoryEditStore(db.service);
    categories = new PrismaPlatformCategoryRepository(db.service);
    const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
    const ids = { next: <K extends string>() => uuid7() as Id<K> };
    deps = {
      unitOfWork: db.unitOfWork,
      store,
      categories,
      policy,
      matcher: { match: (_c, texts) => Promise.resolve(ok(texts.map(() => []))) },
      claimLocales: {
        covered: () => Promise.resolve(ok([...locales.supported, 'en-AU', 'en-US'])),
      },
      audit: {
        record: (_c, entry) => {
          audits.push(entry);
          return Promise.resolve();
        },
      },
      outbox: {
        append: (_c, batch) => {
          events.push(...batch);
          return Promise.resolve();
        },
      },
      clock: new FixedClock(Temporal.Now.instant()),
      ids,
      contentFilter: new ContentFilter(markets),
      importParsers: IMPORT_PARSERS,
      adminCategoryReader: new PrismaAdminCategoryReader(db.service),
    };
    gateOf = () => createUseCaseGate(markets, admitAll);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });
  beforeEach(() => {
    audits = [];
    events = [];
  });

  const row = (cells: Record<string, string>): string[] =>
    header.map((column) => cells[column] ?? '');
  const base64 = (rows: readonly string[][]): string =>
    Buffer.from(
      CSV_BOM + csvLine(header) + rows.map((cells) => csvLine(cells)).join(''),
      'utf8',
    ).toString('base64');
  const treeVersion = async (): Promise<number> => {
    const result = await db.unitOfWork.run(market, async () =>
      ok((await categories.treeVersion(market)).version),
    );
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  /** Dry run then apply at the version the dry run read, read again when another spec moved the tree. */
  const importFile = async (data: string) => {
    for (let attempt = 1; ; attempt += 1) {
      const dry = await new CategoryImportDryRun(gateOf(), deps).execute(admin(), { data });
      if (!dry.ok) throw new Error(`dry run refused: ${dry.error.code}`);
      const applied = await new CategoryImportApply(gateOf(), deps).execute(admin(), {
        data,
        fileSha256: dry.value.fileSha256,
        treeVersion: dry.value.treeVersion,
      });
      const stale = !applied.ok && applied.error.code === 'conflict.stale';
      if (!stale || attempt >= 5) return { dry: dry.value, applied };
    }
  };
  const rowsOf = async (target: typeof market, slugs: readonly string[]) =>
    (
      await owner.query<{
        slug: string;
        status: string;
        parent_id: string | null;
        position: number;
        version: number;
      }>(
        `SELECT slug, status, parent_id, position, version FROM catalog.platform_categories
          WHERE market_id = $1 AND slug = ANY($2) ORDER BY slug`,
        [target.marketId, slugs],
      )
    ).rows;

  it('creates a parent and two children hidden in one unit with one tree version raise', async () => {
    const tag = uuid7().slice(-10);
    const [top, one, two] = [`imp-top-${tag}`, `imp-one-${tag}`, `imp-two-${tag}`];
    const before = await treeVersion();
    const { applied } = await importFile(
      base64([
        row({ slug: two, parent_slug: top, [nameColumn]: `Two ${tag}` }),
        row({ slug: one, parent_slug: top, [nameColumn]: `One ${tag}` }),
        row({ slug: top, [nameColumn]: `Top ${tag}`, seo_title: 'Top title' }),
      ]),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.counts).toEqual({ create: 3, update: 0, unchanged: 0, error: 0 });
    expect(applied.value.treeVersion).toBe(before + 1);
    const rows = await rowsOf(market, [top, one, two]);
    expect(rows.map((r) => [r.slug, r.status, r.version])).toEqual(
      [one, top, two].sort().map((slug) => [slug, 'hidden', 1]),
    );
    const parent = rows.find((r) => r.slug === top)!;
    const children = rows.filter((r) => r.slug !== top);
    expect(children.every((r) => r.parent_id !== null)).toBe(true);
    expect(new Set(children.map((r) => r.position)).size).toBe(2);
    expect(audits.map((a) => a.action).sort()).toEqual([
      'catalog.category-tree.imported',
      'catalog.platform-category.created',
      'catalog.platform-category.created',
      'catalog.platform-category.created',
    ]);
    expect(events).toHaveLength(3);
    expect(parent.parent_id).toBeNull();
    // The other Market has none of them.
    expect(await rowsOf(other, [top, one, two])).toEqual([]);
  });

  it('reads its own export back as unchanged, then updates a changed cell with a new revision', async () => {
    const tag = uuid7().slice(-10);
    const top = `imp-rt-${tag}`;
    expect(
      (await importFile(base64([row({ slug: top, [nameColumn]: `Round ${tag}` })]))).applied.ok,
    ).toBe(true);

    const exported = await new CategoryTreeExport(gateOf(), {
      unitOfWork: db.unitOfWork,
      store,
      policy,
      sheetWriter: { xlsx: () => (async function* () {})() },
      clock: deps.clock,
    }).execute(admin(), { status: 'active,hidden', q: top });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    let text = '';
    for await (const chunk of exported.value.chunks) text += chunk as string;
    const back = await new CategoryImportDryRun(gateOf(), deps).execute(admin(), {
      data: Buffer.from(text, 'utf8').toString('base64'),
    });
    expect(back.ok && back.value.counts).toEqual({ create: 0, update: 0, unchanged: 1, error: 0 });

    const { applied } = await importFile(
      base64([row({ slug: top, [nameColumn]: `Round ${tag} renamed`, show_in_menu: 'false' })]),
    );
    expect(applied.ok && applied.value.counts).toEqual({
      create: 0,
      update: 1,
      unchanged: 0,
      error: 0,
    });
    const [changed] = await rowsOf(market, [top]);
    expect(changed).toMatchObject({ slug: top, version: 2, status: 'hidden' });
    const menu = await owner.query<{ show_in_menu: boolean }>(
      'SELECT show_in_menu FROM catalog.platform_categories WHERE market_id = $1 AND slug = $2',
      [market.marketId, top],
    );
    expect(menu.rows[0]!.show_in_menu).toBe(false);
  });

  it('reads its own XLSX export back as unchanged, with a formula-looking name kept as text', async () => {
    const tag = uuid7().slice(-10);
    const top = `imp-xl-${tag}`;
    expect(
      (await importFile(base64([row({ slug: top, [nameColumn]: `=SUM(${tag})` })]))).applied.ok,
    ).toBe(true);
    const exported = await new CategoryTreeExport(gateOf(), {
      unitOfWork: db.unitOfWork,
      store,
      policy,
      sheetWriter: new ExceljsSheetWriter(),
      clock: deps.clock,
    }).execute(admin(), { format: 'xlsx', status: 'hidden', q: top });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const parts: Uint8Array[] = [];
    for await (const chunk of exported.value.chunks) parts.push(chunk as Uint8Array);
    const back = await new CategoryImportDryRun(gateOf(), {
      ...deps,
      importParsers: [...IMPORT_PARSERS, xlsxParser],
    }).execute(admin(), { data: Buffer.concat(parts).toString('base64') });
    expect(back.ok && back.value.format).toBe('xlsx');
    expect(back.ok && back.value.counts).toEqual({ create: 0, update: 0, unchanged: 1, error: 0 });
  });

  it('writes nothing when the tree version is no longer the one the dry run read', async () => {
    const tag = uuid7().slice(-10);
    const slug = `imp-stale-${tag}`;
    const data = base64([row({ slug, [nameColumn]: `Stale ${tag}` })]);
    const dry = await new CategoryImportDryRun(gateOf(), deps).execute(admin(), { data });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    const applied = await new CategoryImportApply(gateOf(), deps).execute(admin(), {
      data,
      fileSha256: dry.value.fileSha256,
      treeVersion: dry.value.treeVersion - 1,
    });
    expect(applied).toEqual(err({ code: 'conflict.stale' }));
    expect(await rowsOf(market, [slug])).toEqual([]);
  });

  it('rolls back every row, the tree version and the audit when a later row fails inside the unit', async () => {
    const tag = uuid7().slice(-10);
    const slugs = [`imp-rb1-${tag}`, `imp-rb2-${tag}`];
    const data = base64(slugs.map((slug) => row({ slug, [nameColumn]: `Rollback ${slug}` })));
    const dry = await new CategoryImportDryRun(gateOf(), deps).execute(admin(), { data });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    // The second create finds its slug taken after the first row was written to PostgreSQL.
    let calls = 0;
    const flaky = new Proxy(store, {
      get(target, key) {
        if (key === 'slugUnavailable') {
          return (...args: Parameters<PrismaCategoryEditStore['slugUnavailable']>) => {
            calls += 1;
            return calls > 1 ? Promise.resolve(true) : target.slugUnavailable(...args);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const before = await treeVersion();
    const applied = await new CategoryImportApply(gateOf(), { ...deps, store: flaky }).execute(
      admin(),
      { data, fileSha256: dry.value.fileSha256, treeVersion: dry.value.treeVersion },
    );
    expect(applied).toEqual(err({ code: 'category.slug-taken' }));
    expect(await rowsOf(market, slugs)).toEqual([]);
    expect(await treeVersion()).toBe(before);
  });

  it("applies a file of the Market's row cap well inside the unit timeout", async () => {
    const tag = uuid7().slice(-8);
    const cap = deps.policy.maxCategoryImportRows(market);
    const slugs = Array.from({ length: cap }, (_, n) => `imp-cap-${tag}-${n}`);
    const data = base64(slugs.map((slug) => row({ slug, [nameColumn]: `Cap ${slug}` })));
    const started = Date.now();
    const dry = await new CategoryImportDryRun(gateOf(), deps).execute(admin(), { data });
    if (!dry.ok) throw new Error(`dry run refused: ${dry.error.code}`);
    const dryMs = Date.now() - started;
    const applied = await new CategoryImportApply(gateOf(), deps).execute(admin(), {
      data,
      fileSha256: dry.value.fileSha256,
      treeVersion: dry.value.treeVersion,
    });
    const elapsed = Date.now() - started;
    process.stdout.write(`dry run ${dryMs} ms\n`);
    process.stdout.write(`category import of ${cap} rows in ${code}: ${elapsed} ms\n`);
    expect(applied.ok && applied.value.counts.create).toBe(cap);
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});
