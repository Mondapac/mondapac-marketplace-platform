import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { CSV_BOM, csvLine } from '@mondapac/platform-import';
import {
  MemoryCategoryEditStore,
  MemoryTreeVersion,
} from '../../../../../test/support/catalog-category-editor-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { ContentFilter } from '../../../../platform/content-filter/content-filter';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_TREE_IMPORT } from '../../contracts/permissions';
import type { EditableCategory } from '../../domain/category-edit';
import { importFileTargetId } from '../../domain/category-import';
import { IMPORT_PARSERS } from '../../domain/platform-import/import-file';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { CategoryImportDependencies } from '../categories/category-import';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';
import type { SheetWriter } from '../ports/sheet-writer';
import { CategoryImportApply } from './category-import-apply.use-case';
import { CategoryImportDryRun } from './category-import-dry-run.use-case';
import { CategoryTreeExport, exportHeader } from './category-tree-export.use-case';

// The category tree import and export in memory (categories package C7a), on both Market fixtures:
// the key and the acting-as refusal; the round trip (export then import = unchanged); the dry-run
// codes per row; the apply in one unit with one tree version raise; the stale and changed-file
// refusals; the claim-text check failing closed; the formula guard; the Market's file caps. The
// SQL is proved in test/db/catalog-category-import.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-11T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1';

const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${(0xe00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;

describe.each(['AU', 'ZZ'] as const)('category tree import and export in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = policy.locales(market);
  const english = locales.default;
  const second = locales.supported.find((locale) => locale !== english) ?? null;
  const supported = [...locales.supported].sort();
  const header = exportHeader(supported);
  const maxDepth = policy.maxCategoryDepth(market);

  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN as never,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId:
          population === 'seller' ? ('01990000-0000-7000-8000-0000000000a3' as never) : null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = context();
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let store: MemoryCategoryEditStore;
  let tree: MemoryTreeVersion;
  let audits: AuditEntry[];
  let events: PendingEvent[];
  let allow: boolean;
  const englishVocabulary = code === 'AU' ? 'en-AU' : 'en-US';
  const coveredAll = (): Result<readonly string[], never> =>
    ok([...new Set([...locales.supported, englishVocabulary])]);
  let covered: Result<readonly string[], { code: 'claim-text.check-unavailable' }>;
  let matcherDown: boolean;
  let unitOpen: boolean;
  let claimInsideUnit: boolean;
  let xlsxRows: (readonly string[])[];

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        allow &&
          declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.includes(CATALOG_CATEGORY_TREE_IMPORT.key)
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      const saved = {
        rows: new Map(store.rows),
        revisions: store.revisions.length,
        version: tree.version,
        audits: audits.length,
        events: events.length,
      };
      const rollback = (): void => {
        store.rows = saved.rows;
        store.revisions.length = saved.revisions;
        tree.version = saved.version;
        audits.length = saved.audits;
        events.length = saved.events;
      };
      unitOpen = true;
      try {
        const result = await work();
        if (!result.ok) rollback();
        return result;
      } catch (error) {
        rollback();
        throw error;
      } finally {
        unitOpen = false;
      }
    },
  } as unknown as UnitOfWork;
  const matcher: ClaimTextMatcher = {
    match: (_c, texts) => {
      if (unitOpen) claimInsideUnit = true;
      if (matcherDown) return Promise.resolve(err({ code: 'claim-text.check-unavailable' }));
      return Promise.resolve(
        ok(
          texts.map((t) =>
            /halal/i.test(t.text)
              ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }]
              : [],
          ),
        ),
      );
    },
  };
  const claimLocales: ClaimTermLocales = {
    covered: () => {
      if (unitOpen) claimInsideUnit = true;
      return Promise.resolve(covered);
    },
  };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox = {
    append: (_c: CallContext, batch: readonly PendingEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
  };
  const sheetWriter: SheetWriter = {
    xlsx: (_name, rows) =>
      (async function* () {
        for await (const row of rows) xlsxRows.push(row);
        yield new Uint8Array();
      })(),
  };
  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const deps: CategoryImportDependencies = {
      unitOfWork,
      store,
      categories: tree as unknown as PlatformCategoryRepository,
      policy,
      matcher,
      claimLocales,
      audit,
      outbox,
      clock,
      ids,
      contentFilter: new ContentFilter(markets),
      importParsers: IMPORT_PARSERS,
      adminCategoryReader: { treeVersion: () => Promise.resolve(tree.version) },
    };
    return {
      dryRun: new CategoryImportDryRun(gate, deps),
      apply: new CategoryImportApply(gate, deps),
      exporter: new CategoryTreeExport(gate, {
        unitOfWork,
        store,
        policy,
        sheetWriter,
        clock,
      }),
    };
  };

  const stored = (
    n: number,
    parent: number | null,
    patch: Partial<EditableCategory> = {},
  ): EditableCategory => ({
    id: cat(n),
    parentId: parent === null ? null : cat(parent),
    slug: `c${n}`,
    status: 'active',
    hiddenById: null,
    position: n,
    version: 1,
    revisionNo: 1,
    createdByKind: 'admin',
    showInMenu: true,
    imageId: null,
    seo: { title: null, description: null, noindex: false },
    texts: [{ locale: english, name: `Category ${n}`, shortDescription: null, keywords: [] }],
    ...patch,
  });

  /** One file row by column name; every column not named is blank. */
  const row = (cells: Record<string, string>): string[] =>
    header.map((column) => cells[column] ?? '');
  const file = (rows: readonly string[][], head: readonly string[] = header): string =>
    CSV_BOM + csvLine([...head]) + rows.map((cells) => csvLine(cells)).join('');
  const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const nameColumn = `name[${english}]`;

  const exported = async (query: Record<string, unknown> = {}): Promise<string> => {
    const answer = await build().exporter.execute(context(), query);
    if (!answer.ok) throw new Error(`export refused: ${answer.error.code}`);
    let text = '';
    for await (const chunk of answer.value.chunks) text += chunk as string;
    return text;
  };

  beforeEach(() => {
    store = new MemoryCategoryEditStore();
    tree = new MemoryTreeVersion();
    ids = new SequenceIdGenerator(clock);
    audits = [];
    events = [];
    allow = true;
    covered = coveredAll();
    matcherDown = false;
    unitOpen = false;
    claimInsideUnit = false;
    xlsxRows = [];
  });

  describe('access', () => {
    it('declares the protected import key on all three use cases', () => {
      const expected = { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_IMPORT.key] };
      for (const [useCase, name] of [
        [CategoryImportDryRun, 'catalog.category-import-dry-run'],
        [CategoryImportApply, 'catalog.category-import-apply'],
        [CategoryTreeExport, 'catalog.category-tree-export'],
      ] as const) {
        expect(useCase.access.name).toBe(name);
        expect(useCase.access.rule).toEqual(expected);
      }
    });

    it('refuses a caller without the key, a seller session and an acting-as session', async () => {
      const body = { data: base64(file([row({ slug: 'rice', [nameColumn]: 'Rice' })])) };
      allow = false;
      expect(await build().dryRun.execute(context(), body)).toEqual(err({ code: 'access.denied' }));
      expect(await build().exporter.execute(context(), {})).toEqual(err({ code: 'access.denied' }));
      allow = true;
      for (const caller of [context('seller'), actingAs()]) {
        expect(await build().dryRun.execute(caller, body)).toEqual(err({ code: 'access.denied' }));
        expect(
          await build().apply.execute(caller, {
            ...body,
            fileSha256: 'a'.repeat(64),
            treeVersion: 1,
          }),
        ).toEqual(err({ code: 'access.denied' }));
        expect(await build().exporter.execute(caller, {})).toEqual(err({ code: 'access.denied' }));
      }
      expect(store.rows.size).toBe(0);
      expect(tree.version).toBe(1);
    });

    it('refuses an unknown key in the input', async () => {
      expect(await build().dryRun.execute(context(), { data: 'AAAA', extra: 1 } as never)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'extra', code: 'unknown' }] }),
      );
    });
  });

  describe('export', () => {
    it('writes the live tree depth first with the documented columns and the parent slug', async () => {
      store.put(stored(1, null, { seo: { title: 'Dept', description: 'About', noindex: false } }));
      store.put(
        stored(2, 1, {
          status: 'hidden',
          showInMenu: false,
          texts: [
            {
              locale: english,
              name: 'Rice',
              shortDescription: 'Grains',
              keywords: ['basmati', 'jasmine'],
            },
          ],
        }),
      );
      store.put(stored(3, null, { status: 'archived' }));
      const text = await exported();
      const lines = text.replace(CSV_BOM, '').trim().split('\r\n');
      expect(lines[0]).toBe(header.join(','));
      expect(lines).toHaveLength(3);
      expect(lines[1]!.split(',').slice(0, 8)).toEqual([
        cat(1),
        '',
        '1',
        '1',
        'active',
        'c1',
        '',
        'true',
      ]);
      expect(lines[2]).toContain(`${cat(2)},${cat(1)},2,2,hidden,c2,c1,false`);
      expect(lines[2]).toContain(',basmati; jasmine,');
    });

    it('filters by status and by a part of a slug or name, and refuses a bad filter', async () => {
      store.put(stored(1, null));
      store.put(stored(2, null, { status: 'hidden' }));
      store.put(stored(3, null, { status: 'archived' }));
      const slugs = (text: string): string[] =>
        text
          .replace(CSV_BOM, '')
          .trim()
          .split('\r\n')
          .slice(1)
          .map((line) => line.split(',')[5]!);
      expect(slugs(await exported())).toEqual(['c1', 'c2']);
      expect(slugs(await exported({ status: 'archived' }))).toEqual(['c3']);
      expect(slugs(await exported({ status: 'active,hidden,archived', q: 'CATEGORY 2' }))).toEqual([
        'c2',
      ]);
      expect(await build().exporter.execute(context(), { status: 'gone' })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'status', code: 'value' }] }),
      );
      expect(await build().exporter.execute(context(), { format: 'pdf' })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'format', code: 'value' }] }),
      );
    });

    it('guards a CSV cell that starts like a formula, and writes the XLSX cells as plain strings', async () => {
      store.put(
        stored(1, null, {
          texts: [{ locale: english, name: '=SUM(1)', shortDescription: '@cmd', keywords: [] }],
        }),
      );
      const text = await exported();
      expect(text).toContain(",'=SUM(1),'@cmd,");
      const answer = await build().exporter.execute(context(), { format: 'xlsx' });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      for await (const chunk of answer.value.chunks) void chunk;
      expect(xlsxRows[1]).toContain('=SUM(1)');
      expect(xlsxRows[1]!.every((cell) => typeof cell === 'string')).toBe(true);
    });
  });

  describe('round trip', () => {
    it('reads its own export back as all unchanged, and writes nothing', async () => {
      store.put(stored(1, null, { seo: { title: 'Dept', description: 'About', noindex: true } }));
      store.put(
        stored(2, 1, {
          showInMenu: false,
          texts: [
            {
              locale: english,
              name: 'Rice',
              shortDescription: 'Grains',
              keywords: ['basmati', 'jasmine'],
            },
            ...(second === null
              ? []
              : [{ locale: second, name: 'Second', shortDescription: null, keywords: ['k'] }]),
          ],
        }),
      );
      store.put(
        stored(3, 2, {
          texts: [{ locale: english, name: '=1+1', shortDescription: null, keywords: [] }],
        }),
      );
      const before = new Map(store.rows);
      const answer = await build().dryRun.execute(context(), { data: base64(await exported()) });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.value.counts).toEqual({ create: 0, update: 0, unchanged: 3, error: 0 });
      expect(answer.value.clean).toBe(false);
      expect(answer.value.treeVersion).toBe(1);
      const applied = await build().apply.execute(context(), {
        data: base64(await exported()),
        fileSha256: answer.value.fileSha256,
        treeVersion: 1,
      });
      expect(applied).toEqual(
        ok({
          fileSha256: answer.value.fileSha256,
          treeVersion: 1,
          counts: { create: 0, update: 0, unchanged: 3, error: 0 },
          written: false,
        }),
      );
      expect(store.rows).toEqual(before);
      expect(tree.version).toBe(1);
      expect(audits).toEqual([]);
    });
  });

  describe('dry run', () => {
    const run = async (rows: readonly string[][], head: readonly string[] = header) => {
      const answer = await build().dryRun.execute(context(), { data: base64(file(rows, head)) });
      if (!answer.ok) throw new Error(`refused: ${answer.error.code}`);
      return answer.value;
    };
    const codes = (rows: readonly { action: string; code: string | null }[]) =>
      rows.map((r) => `${r.action}:${r.code ?? ''}`);

    it('says create, update and unchanged per row, and writes nothing', async () => {
      store.put(stored(1, null));
      store.put(stored(2, 1));
      const result = await run([
        row({ slug: 'c1', [nameColumn]: 'Category 1' }),
        row({ slug: 'c2', parent_slug: 'c1', [nameColumn]: 'Renamed' }),
        row({ slug: 'new-leaf', parent_slug: 'c2', [nameColumn]: 'New leaf' }),
      ]);
      expect(codes(result.rows)).toEqual(['unchanged:', 'update:', 'create:']);
      expect(result.counts).toEqual({ create: 1, update: 1, unchanged: 1, error: 0 });
      expect(result.clean).toBe(true);
      expect(result.rows.map((r) => r.rowNumber)).toEqual([2, 3, 4]);
      expect(store.rows.size).toBe(2);
      expect(tree.version).toBe(1);
      expect(audits).toEqual([]);
    });

    it('plans a child under a parent created earlier or later in the same file', async () => {
      const result = await run([
        row({ slug: 'leaf', parent_slug: 'mid', [nameColumn]: 'Leaf' }),
        row({ slug: 'mid', parent_slug: 'top', [nameColumn]: 'Mid' }),
        row({ slug: 'top', [nameColumn]: 'Top' }),
      ]);
      expect(codes(result.rows)).toEqual(['create:', 'create:', 'create:']);
    });

    it('gives a code per error row and still plans the rest', async () => {
      store.put(stored(1, null));
      store.put(stored(2, 1));
      store.put(stored(3, null));
      store.put(stored(4, null, { status: 'merged', slug: 'old-one' }));
      const deep = Array.from({ length: maxDepth }, (_, level) =>
        row({
          slug: `deep-${level}`,
          parent_slug: level === 0 ? '' : `deep-${level - 1}`,
          [nameColumn]: `Deep ${level}`,
        }),
      );
      const result = await run([
        row({ slug: 'Bad Slug', [nameColumn]: 'X' }), // 2: slug.invalid
        row({ slug: 'dup', [nameColumn]: 'Dup' }), // 3: create
        row({ slug: 'dup', [nameColumn]: 'Dup again' }), // 4: slug.duplicate
        row({ slug: 'orphan', parent_slug: 'nowhere', [nameColumn]: 'Orphan' }), // 5: parent.not-found
        row({ slug: 'c2', parent_slug: 'c3', [nameColumn]: 'Category 2' }), // 6: move.not-supported
        row({ slug: 'old-one', [nameColumn]: 'Old' }), // 7: slug.taken
        row({ slug: 'blank-name', [nameColumn]: '' }), // 8: required locale
        row({ slug: 'twin', parent_slug: 'c1', [nameColumn]: 'category 2' }), // 9: sibling name
        row({ slug: 'flag', [nameColumn]: 'Flag', show_in_menu: 'maybe' }), // 10: show-in-menu.invalid
        ...deep, // maxDepth rows: the last is too deep only when the chain starts below a root
        row({ slug: 'too-deep', parent_slug: `deep-${maxDepth - 1}`, [nameColumn]: 'Too deep' }),
      ]);
      expect(result.rows.slice(0, 9).map((r) => `${r.action}:${r.code ?? ''}`)).toEqual([
        'error:slug.invalid',
        'create:',
        'error:slug.duplicate',
        'error:parent.not-found',
        'error:move.not-supported',
        'error:slug.taken',
        'error:required',
        'error:sibling-name-taken',
        'error:show-in-menu.invalid',
      ]);
      expect(result.rows.at(-1)).toMatchObject({ action: 'error', code: 'depth.exceeded' });
      expect(result.rows.slice(9, -1).every((r) => r.action === 'create')).toBe(true);
      expect(result.clean).toBe(false);
      expect(store.rows.size).toBe(4);
    });

    it('treats a parent that is itself an error as not found, and a cycle as not found', async () => {
      const result = await run([
        row({ slug: 'bad-parent', [nameColumn]: '' }),
        row({ slug: 'child', parent_slug: 'bad-parent', [nameColumn]: 'Child' }),
        row({ slug: 'aa', parent_slug: 'bb', [nameColumn]: 'A' }),
        row({ slug: 'bb', parent_slug: 'aa', [nameColumn]: 'B' }),
      ]);
      expect(codes(result.rows)).toEqual([
        'error:required',
        'error:parent.not-found',
        'error:parent.not-found',
        'error:parent.not-found',
      ]);
    });

    it('refuses a slug held by another category in the last 12 months', async () => {
      store.heldSlugs.add('held');
      const result = await run([row({ slug: 'held', [nameColumn]: 'Held' })]);
      expect(codes(result.rows)).toEqual(['error:slug.taken']);
    });

    it('keeps the locales the file has no columns for, and the no-index flag', async () => {
      if (second === null) return;
      store.put(
        stored(1, null, {
          seo: { title: 'T', description: null, noindex: true },
          texts: [
            { locale: english, name: 'One', shortDescription: null, keywords: [] },
            { locale: second, name: 'Uno', shortDescription: null, keywords: [] },
          ],
        }),
      );
      const head = ['slug', 'parent_slug', nameColumn, 'seo_title'];
      const result = await run([['c1', '', 'One', 'T']], head);
      expect(codes(result.rows)).toEqual(['unchanged:']);
      const changed = await run([['c1', '', 'One', 'T2']], head);
      expect(codes(changed.rows)).toEqual(['update:']);
    });

    it('refuses a header with an unknown, repeated, unsupported or missing column', async () => {
      const refuse = async (head: string[]) => {
        const answer = await build().dryRun.execute(context(), {
          data: base64(file([], head).concat(csvLine(head.map(() => 'x')))),
        });
        return answer.ok ? null : answer.error;
      };
      expect(await refuse(['slug', 'parent_slug', nameColumn, 'color'])).toEqual({
        code: 'import.columns-invalid',
        fields: [{ path: 'columns.4', code: 'column.unknown' }],
      });
      expect(await refuse(['slug', 'parent_slug', nameColumn, 'slug'])).toEqual({
        code: 'import.columns-invalid',
        fields: [{ path: 'columns.4', code: 'column.duplicate' }],
      });
      expect(await refuse(['slug', 'parent_slug', nameColumn, 'name[xx-YY]'])).toEqual({
        code: 'import.columns-invalid',
        fields: [{ path: 'columns.4', code: 'locale-unsupported' }],
      });
      expect(await refuse(['slug', nameColumn])).toEqual({
        code: 'import.columns-invalid',
        fields: [{ path: 'columns.parent_slug', code: 'column.missing' }],
      });
      expect(await refuse(['slug', 'parent_slug'])).toEqual({
        code: 'import.columns-invalid',
        fields: [{ path: `columns.name[${english}]`, code: 'column.missing' }],
      });
    });

    it("applies the Market's file size and row caps", async () => {
      const maxRows = policy.maxCategoryImportRows(market);
      const rows = Array.from({ length: maxRows + 1 }, (_, n) =>
        row({ slug: `r${n}`, [nameColumn]: `Row ${n}` }),
      );
      const tooMany = await build().dryRun.execute(context(), { data: base64(file(rows)) });
      expect(tooMany).toEqual(err({ code: 'file.too-many-rows', rows: maxRows + 1, max: maxRows }));
      const maxBytes = policy.maxCategoryImportBytes(market);
      const huge = await build().dryRun.execute(context(), {
        data: Buffer.alloc(maxBytes + 10, 97).toString('base64'),
      });
      expect(huge).toEqual(err({ code: 'file.too-large', maxBytes }));
      expect(maxRows).toBe(code === 'AU' ? 2000 : 500);
    });

    it('refuses data that is not base64, not a file, or empty', async () => {
      expect(await build().dryRun.execute(context(), { data: 'not base64!' })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'data', code: 'format' }] }),
      );
      expect(await build().dryRun.execute(context(), { data: '' })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'data', code: 'required' }] }),
      );
      expect(await build().dryRun.execute(context(), {})).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'data', code: 'required' }] }),
      );
    });

    it('strips the guard quote and a leading tab or carriage return from a cell', async () => {
      store.put(
        stored(1, null, {
          texts: [{ locale: english, name: '=1+1', shortDescription: null, keywords: [] }],
        }),
      );
      const result = await run([
        row({ slug: 'c1', [nameColumn]: '=1+1' }),
        row({ slug: 'tabbed', [nameColumn]: '\tRice' }),
        row({ slug: 'carriage', [nameColumn]: '\r=Pasta' }),
      ]);
      expect(codes(result.rows)).toEqual(['unchanged:', 'create:', 'create:']);
    });
  });

  describe('claim-text check', () => {
    const run = async (rows: readonly string[][]) =>
      build().dryRun.execute(context(), { data: base64(file(rows)) });

    it('makes a row with a claim word an error naming the path, never the word', async () => {
      const answer = await run([
        row({ slug: 'rice', [nameColumn]: 'Rice' }),
        row({
          slug: 'halal-rice',
          [nameColumn]: 'Halal rice',
          [`keywords[${english}]`]: 'grain; halal',
        }),
      ]);
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.value.rows[0]!.action).toBe('create');
      expect(answer.value.rows[1]).toMatchObject({ action: 'error', code: 'claim-word' });
      expect(answer.value.rows[1]!.issues.map((i) => i.path)).toEqual([
        `texts.${english}.name`,
        `texts.${english}.keywords.1`,
        'slug',
      ]);
      expect(JSON.stringify(answer.value)).not.toMatch(/Halal rice/);
    });

    it('applies the content filter to every cell', async () => {
      const bad = code === 'AU' ? 'shit' : 'zzbad';
      const answer = await run([row({ slug: 'rice', [nameColumn]: `${bad} rice` })]);
      expect(answer.ok && answer.value.rows[0]).toMatchObject({
        action: 'error',
        code: 'blocked-term',
      });
    });

    it('fails closed for a locale the vocabulary does not cover, and when it cannot be read', async () => {
      if (second !== null) {
        covered = ok(
          [...new Set([...locales.supported, englishVocabulary])].filter(
            (locale) => locale !== second,
          ),
        );
        const answer = await run([
          row({ slug: 'rice', [nameColumn]: 'Rice', [`name[${second}]`]: 'Second' }),
        ]);
        expect(answer.ok && answer.value.rows[0]).toMatchObject({ action: 'error' });
        expect(
          answer.ok && answer.value.rows[0]!.issues.map((i) => `${i.path}:${i.code}`),
        ).toContain(`texts.${second}.name:locale-uncheckable`);
      }
      covered = err({ code: 'claim-text.check-unavailable' });
      expect(await run([row({ slug: 'rice', [nameColumn]: 'Rice' })])).toEqual(
        err({ code: 'claim-text.check-unavailable' }),
      );
      covered = coveredAll();
      matcherDown = true;
      expect(await run([row({ slug: 'rice', [nameColumn]: 'Rice' })])).toEqual(
        err({ code: 'claim-text.check-unavailable' }),
      );
    });

    it('checks with no unit open, in the dry run and in the apply', async () => {
      const data = base64(file([row({ slug: 'rice', [nameColumn]: 'Rice' })]));
      const dry = await build().dryRun.execute(context(), { data });
      expect(dry.ok).toBe(true);
      if (!dry.ok) return;
      await build().apply.execute(context(), {
        data,
        fileSha256: dry.value.fileSha256,
        treeVersion: dry.value.treeVersion,
      });
      expect(claimInsideUnit).toBe(false);
    });
  });

  describe('apply', () => {
    const request = async (rows: readonly string[][]) => {
      const data = base64(file(rows));
      const dry = await build().dryRun.execute(context(), { data });
      if (!dry.ok) throw new Error(`dry run refused: ${dry.error.code}`);
      return { data, fileSha256: dry.value.fileSha256, treeVersion: dry.value.treeVersion };
    };

    it('creates and updates in one unit with one tree version raise, one audit row per write and one for the import', async () => {
      store.put(stored(1, null));
      store.put(stored(2, 1));
      const body = await request([
        row({ slug: 'c2', parent_slug: 'c1', [nameColumn]: 'Renamed' }),
        row({ slug: 'leaf', parent_slug: 'mid', [nameColumn]: 'Leaf', seo_title: 'Leaf title' }),
        row({ slug: 'mid', parent_slug: 'c1', [nameColumn]: 'Mid', show_in_menu: 'no' }),
      ]);
      const answer = await build().apply.execute(context(), body);
      expect(answer).toEqual(
        ok({
          fileSha256: body.fileSha256,
          treeVersion: 2,
          counts: { create: 2, update: 1, unchanged: 0, error: 0 },
          written: true,
        }),
      );
      expect(tree.version).toBe(2);
      const bySlug = new Map([...store.rows.values()].map((r) => [r.slug, r] as const));
      expect(bySlug.get('c2')!.texts[0]!.name).toBe('Renamed');
      expect(bySlug.get('mid')).toMatchObject({
        status: 'hidden',
        parentId: cat(1),
        showInMenu: false,
        createdByKind: 'admin',
      });
      expect(bySlug.get('leaf')).toMatchObject({
        status: 'hidden',
        parentId: bySlug.get('mid')!.id,
        seo: { title: 'Leaf title', description: null, noindex: false },
      });
      expect(audits.map((a) => a.action)).toEqual([
        'catalog.platform-category.details-changed',
        'catalog.platform-category.created',
        'catalog.platform-category.created',
        'catalog.category-tree.imported',
      ]);
      const imported = audits.at(-1)!;
      expect(imported.targetId).toBe(importFileTargetId(body.fileSha256));
      expect(imported.targetType).toBe('catalog.category-tree-import');
      expect(JSON.stringify(imported)).not.toMatch(/Leaf|Mid|Renamed/);
      expect(events.map((e) => e.type)).toEqual([
        'catalog.platform-category-changed.v1',
        'catalog.platform-category-created.v1',
        'catalog.platform-category-created.v1',
      ]);
      // The same file again: nothing left to do.
      const again = await build().apply.execute(context(), {
        ...body,
        treeVersion: 2,
      });
      expect(again).toMatchObject({ ok: true, value: { written: false, treeVersion: 2 } });
    });

    it('writes nothing when any row is an error', async () => {
      const body = await request([
        row({ slug: 'fine', [nameColumn]: 'Fine' }),
        row({ slug: 'orphan', parent_slug: 'nowhere', [nameColumn]: 'Orphan' }),
      ]);
      expect(await build().apply.execute(context(), body)).toEqual(
        err({ code: 'import.has-errors', errors: 1 }),
      );
      expect(store.rows.size).toBe(0);
      expect(tree.version).toBe(1);
      expect(audits).toEqual([]);
    });

    it('refuses a file that is not the one the dry run read, and a tree that changed since', async () => {
      const body = await request([row({ slug: 'fine', [nameColumn]: 'Fine' })]);
      const other = base64(file([row({ slug: 'other', [nameColumn]: 'Other' })]));
      expect(await build().apply.execute(context(), { ...body, data: other })).toEqual(
        err({ code: 'import.file-changed' }),
      );
      tree.version = 2;
      expect(await build().apply.execute(context(), body)).toEqual(err({ code: 'conflict.stale' }));
      expect(store.rows.size).toBe(0);
      expect(await build().apply.execute(context(), { ...body, treeVersion: -1 })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(
        await build().apply.execute(context(), { ...body, fileSha256: 'nope', treeVersion: 1 }),
      ).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'fileSha256', code: 'format' }] }),
      );
    });

    it('rolls back the whole file when the tree moves under the unit (stale tree version)', async () => {
      const body = await request([
        row({ slug: 'one', [nameColumn]: 'One' }),
        row({ slug: 'two', [nameColumn]: 'Two' }),
      ]);
      // Another admin's structural write lands between the read and the unit.
      const bump = tree.bumpTreeVersion.bind(tree);
      tree.bumpTreeVersion = (m, expected) => bump(m, expected + 1);
      await expect(build().apply.execute(context(), body)).resolves.toEqual(
        err({ code: 'conflict.stale' }),
      );
      expect(store.rows.size).toBe(0);
    });

    it('rolls back every row when a later row is refused inside the unit', async () => {
      const body = await request([
        row({ slug: 'one', [nameColumn]: 'One' }),
        row({ slug: 'two', [nameColumn]: 'Two' }),
      ]);
      // A slug becomes held after the dry run: the lock-and-check in the create refuses it.
      const original = store.slugUnavailable.bind(store);
      let calls = 0;
      store.slugUnavailable = (...args) => {
        calls += 1;
        return calls > 3 ? Promise.resolve(true) : original(...args);
      };
      const answer = await build().apply.execute(context(), body);
      expect(answer).toEqual(err({ code: 'category.slug-taken' }));
      expect(store.rows.size).toBe(0);
      expect(tree.version).toBe(1);
      expect(audits).toEqual([]);
    });
  });
});
