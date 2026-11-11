import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  halalOnlyMatcher,
  MemoryAttributeDefinitionStore as MemoryStore,
  MemoryAttributeRelaxationStore,
} from '../../../../../test/support/catalog-attribute-editor-fakes';
import { MemoryAttributeAdminReader } from '../../../../../test/support/catalog-attribute-admin-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_ATTRIBUTE_EDIT,
  CATALOG_ATTRIBUTE_IMPORT,
  CATALOG_ATTRIBUTE_VIEW,
} from '../../contracts/permissions';
import type { AttributeDefinition } from '../../domain/attribute-definition';
import { csvParser } from '../../domain/platform-import/import-file';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { ATTRIBUTE_LOAD_MAX } from '../attributes/attribute-admin-views';
import { prepareImport } from '../attribute-files/import-prepare';
import type { AttributeDefinitionRecord } from '../ports/attribute-admin.reader';
import type { RateReservation } from '../../domain/rate-limits';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { SheetWriter } from '../ports/sheet-writer';
import { AttributeDefinitionCreate } from './attribute-definition-create.use-case';
import { AttributeDefinitionEdit } from './attribute-definition-edit.use-case';
import { AttributeFilesExport } from './attribute-files-export.use-case';
import { AttributeImportCheck } from './attribute-import-check.use-case';
import { AttributeImportRun } from './attribute-import-run.use-case';

// The attribute export and import (attributes package A9) in memory, on both Market fixtures: the
// keys and the admin population; the export's columns per language, the Missing filter and the
// counts; the check, which writes nothing; the run, which goes through the editor's own use cases
// (claim words, versions, audit rows) and reports each row; the file the run is tied to; and the
// upload limit. The SQL readers are proved in test/db, the routes in test/catalog-attribute-files.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-11T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1';

/** The byte order mark the CSV starts with. */
const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const recordOf = (definition: AttributeDefinition): AttributeDefinitionRecord => {
  const s = definition.state;
  return {
    id: s.id,
    code: s.code,
    dataType: s.dataType,
    localizable: s.localizable,
    status: s.status,
    createdByKind: s.createdByKind,
    createdAt: s.createdAt,
    version: s.version,
    revision: {
      id: s.revisionId,
      revisionNo: s.revisionNo,
      material: s.material,
      isVariantOption: s.isVariantOption,
      bounds: s.bounds,
      names: s.names,
      options: s.options,
      display: s.display,
      authorKind: 'admin',
      authorAccountId: null,
      createdAt: s.revisedAt,
    },
  };
};

describe.each(['AU', 'ZZ'] as const)('attribute files in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = policy.locales(market);
  const english = locales.default;
  const second = locales.supported.find((locale) => locale !== english) ?? null;

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

  let store: MemoryStore;
  let reader: MemoryAttributeAdminReader;
  let audits: AuditEntry[];
  let granted: Set<string>;
  let reservations: string[];
  let count: number;

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => granted.has(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const claimLocales: ClaimTermLocales = {
    covered: () => Promise.resolve(ok([...locales.supported])),
  };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const counters: RateCounterRepository = {
    reserve: (_m, list, now): Promise<readonly RateReservation[]> => {
      for (const counter of list) reservations.push(counter.limit.kind);
      return Promise.resolve(
        list.map((counter) => ({ kind: counter.limit.kind, count, windowStartedAt: now })),
      );
    },
    purgeStartedBefore: () => Promise.resolve(0),
  };
  const sheetWriter: SheetWriter = {
    xlsx: async function* (_name, rows) {
      for await (const row of rows) yield new TextEncoder().encode(row.join('\t') + '\n');
    },
  };
  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const editDeps = {
      unitOfWork,
      attributeStore: store,
      relaxations: new MemoryAttributeRelaxationStore(),
      policy,
      matcher: halalOnlyMatcher,
      claimLocales,
      audit,
      clock,
      ids,
    };
    const create = new AttributeDefinitionCreate(gate, editDeps);
    const edit = new AttributeDefinitionEdit(gate, editDeps);
    const prepare = {
      unitOfWork,
      attributeAdminReader: reader,
      policy,
      importParsers: [csvParser],
      counters,
      counterKeys: { keyOf: () => new Uint8Array(32) },
      clock,
    };
    return {
      prepare,
      create,
      edit,
      exporter: new AttributeFilesExport(gate, {
        unitOfWork,
        attributeAdminReader: reader,
        policy,
        sheetWriter,
        clock,
      }),
      check: new AttributeImportCheck(gate, prepare),
      run: new AttributeImportRun(gate, {
        ...prepare,
        attributeCreate: create,
        attributeEdit: edit,
        audit,
        ids,
      }),
    };
  };

  /** The reader sees what the store holds, as the SQL reader sees the tables. */
  const sync = (): void => {
    reader.reset();
    for (const definition of store.rows.values())
      reader.seedDefinition(market.marketId, recordOf(definition));
  };

  beforeEach(() => {
    store = new MemoryStore();
    reader = new MemoryAttributeAdminReader();
    audits = [];
    granted = new Set([
      CATALOG_ATTRIBUTE_VIEW.key,
      CATALOG_ATTRIBUTE_EDIT.key,
      CATALOG_ATTRIBUTE_IMPORT.key,
    ]);
    reservations = [];
    count = 1;
    ids = new SequenceIdGenerator(clock);
  });

  const seed = async (): Promise<void> => {
    const { create } = build();
    for (const body of [
      { code: 'cut', dataType: 'text', names: { [english]: 'Cut' } },
      {
        code: 'pack-size',
        dataType: 'select',
        names: { [english]: 'Pack size' },
        options: [
          { code: 'g500', labels: { [english]: '500 g' } },
          { code: 'kg1', labels: { [english]: '1 kg' } },
        ],
      },
    ]) {
      const made = await create.execute(context(), body);
      if (!made.ok) throw new Error(`seed failed: ${made.error.code}`);
    }
    audits = [];
    sync();
  };

  const text = async (chunks: AsyncIterable<string | Uint8Array>): Promise<string> => {
    let out = '';
    for await (const chunk of chunks)
      out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return withoutBom(out);
  };
  const exported = async (input: Record<string, unknown>): Promise<string> => {
    const answer = await build().exporter.execute(context(), input);
    if (!answer.ok) throw new Error(`export failed: ${answer.error.code}`);
    return text(answer.value.chunks);
  };
  const b64 = (csv: string): string => Buffer.from(csv, 'utf8').toString('base64');

  const tokens = (checked: {
    readonly ok: boolean;
    readonly value?: unknown;
  }): { fileSha256: string; planSha256: string } => {
    const view = checked.ok ? (checked.value as { fileSha256: string; planSha256: string }) : null;
    return { fileSha256: view?.fileSha256 ?? '', planSha256: view?.planSha256 ?? '' };
  };

  describe('export', () => {
    it('writes a column per language and the product counts, and the file imports back unchanged', async () => {
      await seed();
      reader.counts.set(`${market.marketId}:cut`, 7);
      const csv = await exported({ kind: 'attributes' });
      const [header, ...lines] = csv.trim().split('\r\n');
      expect(header).toContain(`name[${english}]`);
      if (second !== null) expect(header).toContain(`help[${second}]`);
      expect(lines.map((line) => line.split(',')[0])).toEqual(['cut', 'pack-size']);
      expect(lines[0]).toContain(',7,');

      const checked = await build().check.execute(context(), { data: b64(csv) });
      expect(checked).toEqual(
        ok(
          expect.objectContaining({
            kind: 'attributes',
            counts: { rows: 2, create: 0, update: 0, unchanged: 2, errors: 0 },
            canRun: false,
          }),
        ),
      );
    });

    it('exports values with their counts and keeps only what lacks a language with missing', async () => {
      await seed();
      reader.optionCounts.set(`${market.marketId}:pack-size:g500`, 3);
      const values = await exported({ kind: 'values' });
      expect(
        values
          .trim()
          .split('\r\n')
          .slice(1)
          .map((line) => line.split(',').slice(0, 3)),
      ).toEqual([
        ['pack-size', 'g500', 'yes'],
        ['pack-size', 'kg1', 'yes'],
      ]);
      expect(values).toContain(',3,');
      if (second === null) return;
      const missing = await exported({ kind: 'values', missing: second });
      expect(missing.trim().split('\r\n')).toHaveLength(3);
      const none = await exported({ kind: 'attributes', missing: english });
      expect(none.trim().split('\r\n')).toHaveLength(1);
    });

    it('writes feature sets one row per attribute, and an XLSX with the same cells', async () => {
      await seed();
      reader.seedFeatureSet(market.marketId, {
        id: '01990000-0000-7000-8000-0000000000f1' as never,
        code: 'meat',
        status: 'active',
        createdByKind: 'admin',
        createdAt: T0,
        revisionNo: 1,
        version: 1,
        names: { [english]: 'Meat' },
        groups: [
          {
            groupCode: 'core',
            attributes: [
              { code: 'brand', required: true, isVariantOption: false, level: 'required' },
            ],
          },
        ],
      });
      const csv = await exported({ kind: 'feature-sets' });
      expect(csv.trim().split('\r\n')[1]).toContain('meat,active,core,brand,required,no');
      const xlsx = await exported({ kind: 'attributes', format: 'xlsx' });
      expect(xlsx.split('\n')[1]!.split('\t').slice(0, 2)).toEqual(['cut', 'text']);
    });

    it('is for admins who can view, and refuses an unknown kind, format or locale', async () => {
      const { exporter } = build();
      expect(await exporter.execute(context('seller'), { kind: 'attributes' })).toEqual(
        err({ code: 'access.denied' }),
      );
      granted.delete(CATALOG_ATTRIBUTE_VIEW.key);
      expect(await exporter.execute(context(), { kind: 'attributes' })).toEqual(
        err({ code: 'access.denied' }),
      );
      granted.add(CATALOG_ATTRIBUTE_VIEW.key);
      const fields = async (input: Record<string, unknown>) => {
        const answer = await exporter.execute(context(), input);
        return answer.ok ? null : answer.error;
      };
      expect(await fields({})).toMatchObject({ fields: [{ path: 'kind', code: 'required' }] });
      expect(await fields({ kind: 'products' })).toMatchObject({
        fields: [{ path: 'kind', code: 'unknown' }],
      });
      expect(await fields({ kind: 'values', format: 'pdf' })).toMatchObject({
        fields: [{ path: 'format' }],
      });
      expect(await fields({ kind: 'values', missing: 'xx-XX' })).toMatchObject({
        fields: [{ path: 'missing', code: 'unsupported' }],
      });
      expect(await fields({ kind: 'feature-sets', missing: english })).toMatchObject({
        fields: [{ path: 'missing', code: 'not-allowed' }],
      });
      expect(await fields({ kind: 'values', extra: 1 })).toMatchObject({
        code: 'validation.failed',
      });
    });
  });

  describe('check', () => {
    const header = `code,type,name[${english}]`;

    it('shows the diff and writes nothing: no attribute, no audit row', async () => {
      await seed();
      const before = store.rows.size;
      const answer = await build().check.execute(context(), {
        data: b64(
          [header, 'cut,text,Cut cuts', 'weave,text,Weave', 'pack-size,integer,Pack'].join('\n'),
        ),
      });
      expect(answer.ok && answer.value.counts).toEqual({
        rows: 3,
        create: 1,
        update: 1,
        unchanged: 0,
        errors: 1,
      });
      expect(answer.ok && answer.value.rows.map((row) => [row.key, row.action])).toEqual([
        ['pack-size', 'error'],
        ['cut', 'update'],
        ['weave', 'create'],
      ]);
      expect(store.rows.size).toBe(before);
      expect(audits).toEqual([]);
      expect(reservations).toEqual([
        'platform-import-check.account.day',
        'platform-import-check.account.hour',
      ]);
    });

    it('needs both protected keys, an admin, a readable file and the upload allowance', async () => {
      const { check: use } = build();
      const data = b64([header, `cut,text,Cut`].join('\n'));
      expect(await use.execute(context('seller'), { data })).toEqual(
        err({ code: 'access.denied' }),
      );
      granted.delete(CATALOG_ATTRIBUTE_IMPORT.key);
      expect(await use.execute(context(), { data })).toEqual(err({ code: 'access.denied' }));
      granted.add(CATALOG_ATTRIBUTE_IMPORT.key);
      expect(await use.execute(context(), {})).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'data', code: 'required' }] }),
      );
      expect(await use.execute(context(), { data: 'not base64!' })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'data', code: 'format' }] }),
      );
      expect(await use.execute(context(), { data: b64('code,type\n') })).toEqual(
        err({ code: 'file.no-rows' }),
      );
      expect(await use.execute(context(), { data: b64('colour,size\nred,1') })).toEqual(
        err({ code: 'columns.kind-unknown' }),
      );
      count = 21;
      expect(await use.execute(context(), { data })).toMatchObject({
        ok: false,
        error: { code: 'request.throttled' },
      });
    });
  });

  describe('run', () => {
    const header = `code,type,name[${english}]`;

    it('applies creates and updates through the editor and writes the run audit row and a report', async () => {
      await seed();
      const csv = [header, 'cut,text,Cut cuts', 'weave,text,Weave', 'cut,text,again'].join('\n');
      const checked = await build().check.execute(context(), { data: b64(csv) });
      expect(checked.ok && checked.value.counts.errors).toBe(1);
      const sha = tokens(checked);

      const refused = await build().run.execute(context(), { data: b64(csv), ...sha });
      expect(refused).toEqual(err({ code: 'import.errors-not-skipped' }));
      expect(store.rows.size).toBe(2);

      const answer = await build().run.execute(context(), {
        data: b64(csv),
        ...sha,
        skipErrors: true,
      });
      expect(answer).toEqual(
        ok(
          expect.objectContaining({
            kind: 'attributes',
            rows: 3,
            created: 1,
            updated: 1,
            unchanged: 0,
            skipped: 1,
            failed: 0,
          }),
        ),
      );
      expect(
        [...store.rows.values()].map((d) => [
          d.state.code,
          d.state.names[english],
          d.state.version,
        ]),
      ).toEqual([
        ['cut', 'Cut cuts', 2],
        ['pack-size', 'Pack size', 1],
        ['weave', 'Weave', 1],
      ]);
      expect(audits.map((a) => a.action)).toEqual([
        'catalog.attribute-definition.revised',
        'catalog.attribute-definition.created',
        'catalog.attribute-import.ran',
      ]);
      const ran = audits.find((a) => a.action === 'catalog.attribute-import.ran')!;
      expect(ran.after).toEqual({
        kind: 'attributes',
        skipErrors: true,
        rows: 3,
        created: 1,
        updated: 1,
        unchanged: 0,
        failed: 0,
        skipped: 1,
      });
      const report = answer.ok
        ? Buffer.from(answer.value.report.data, 'base64').toString('utf8')
        : '';
      expect(withoutBom(report).trim().split('\r\n')).toEqual([
        'row,key,result,detail',
        '2,cut,updated,',
        '3,weave,created,',
        '4,cut,skipped,code:repeated',
      ]);
    });

    it('is tied to the checked file, and a second run changes nothing', async () => {
      await seed();
      const csv = [header, 'weave,text,Weave'].join('\n');
      const { run } = build();
      expect(
        await run.execute(context(), {
          data: b64(csv),
          fileSha256: 'a'.repeat(64),
          planSha256: 'b'.repeat(64),
        }),
      ).toEqual(err({ code: 'import.file-changed' }));
      expect(
        await run.execute(context(), {
          data: b64(csv),
          fileSha256: 'nope',
          planSha256: 'b'.repeat(64),
        }),
      ).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'fileSha256', code: 'format' }] }),
      );
      const sha = await build().check.execute(context(), { data: b64(csv) });
      const fileSha256 = tokens(sha);
      expect((await run.execute(context(), { data: b64(csv), ...fileSha256 })).ok).toBe(true);
      sync();
      // The attribute moved on since the check: its token no longer fits.
      const replay = await build().run.execute(context(), { data: b64(csv), ...fileSha256 });
      expect(replay).toEqual(err({ code: 'import.plan-changed' }));
      const fresh = tokens(await build().check.execute(context(), { data: b64(csv) }));
      const again = await build().run.execute(context(), { data: b64(csv), ...fresh });
      expect(again).toEqual(err({ code: 'import.nothing-to-import' }));
    });

    it('fails a row the editor refuses, with its code, and goes on with the others', async () => {
      await seed();
      const csv = [header, 'sweet,text,Halal sweet', 'salty,text,Salty'].join('\n');
      const checked = await build().check.execute(context(), { data: b64(csv) });
      const answer = await build().run.execute(context(), {
        data: b64(csv),
        ...tokens(checked),
      });
      expect(answer).toEqual(ok(expect.objectContaining({ created: 1, failed: 1 })));
      expect(answer.ok && answer.value.results).toEqual([
        { rowNumber: 2, key: 'sweet', result: 'failed', code: 'attribute.claim-word' },
      ]);
      expect([...store.rows.values()].map((d) => d.state.code)).toEqual([
        'cut',
        'pack-size',
        'salty',
      ]);
      // The answer carries a code, never the text of the file.
      expect(JSON.stringify(answer)).not.toContain('Halal sweet');
    });

    it('refuses an acting-as session at the shared preparation, not only at the gate', async () => {
      await seed();
      const base = context();
      const actingAs: CallContext = {
        ...base,
        actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never,
      };
      const refused = await prepareImport(build().prepare, actingAs, {
        data: b64(`${header}\ncut,text,Cut`),
      });
      expect(refused).toEqual(err({ code: 'access.denied' }));
    });

    it('refuses a file of more than 500 writes', async () => {
      await seed();
      const rows = Array.from({ length: 501 }, (_, i) => `new-${i},text,New ${i}`);
      const checked = await build().check.execute(context(), {
        data: b64([header, ...rows].join('\n')),
      });
      expect(checked).toEqual(err({ code: 'import.too-many-writes', max: 500 }));
    });

    it('refuses a file that would take the Market to the most attributes the admin can load', async () => {
      await seed();
      sync();
      const [first] = [...store.rows.values()];
      for (let i = 0; i < ATTRIBUTE_LOAD_MAX - 3; i += 1) {
        reader.seedDefinition(market.marketId, {
          ...recordOf(first!),
          id: `filler-${i}` as never,
          code: `filler-${i}`,
        });
      }
      const checked = await build().check.execute(context(), {
        data: b64(`${header}\nnew-a,text,New a\nnew-b,text,New b`),
      });
      expect(checked).toEqual(err({ code: 'import.too-many-attributes' }));
    });

    it('fails a stale attribute and a code taken meanwhile, and never runs in an acting-as session', async () => {
      await seed();
      const csv = [header, 'cut,text,Cut cuts'].join('\n');
      const checked = await build().check.execute(context(), { data: b64(csv) });
      const fileSha256 = tokens(checked);
      store.raceNext = true;
      const stale = await build().run.execute(context(), { data: b64(csv), ...fileSha256 });
      expect(stale.ok && stale.value.results).toEqual([
        { rowNumber: 2, key: 'cut', result: 'failed', code: 'attribute.stale' },
      ]);

      const base = context();
      const actingAs: CallContext = {
        ...base,
        actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never,
      };
      const refused = await build().run.execute(actingAs, { data: b64(csv), ...fileSha256 });
      expect(refused).toEqual(err({ code: 'access.denied' }));
    });

    it('adds and renames values as one revision and reports the rows that were not applied together', async () => {
      await seed();
      const values = `attribute_code,value_code,active,label[${english}]`;
      const csv = [
        values,
        'pack-size,g250,yes,250 g',
        'pack-size,kg1,,1 kilo',
        'pack-size,g100,yes,Halal 100 g',
      ].join('\n');
      const checked = await build().check.execute(context(), { data: b64(csv) });
      expect(checked.ok && checked.value.counts).toEqual({
        rows: 3,
        create: 2,
        update: 1,
        unchanged: 0,
        errors: 0,
      });
      const answer = await build().run.execute(context(), {
        data: b64(csv),
        ...tokens(checked),
      });
      expect(answer).toEqual(ok(expect.objectContaining({ failed: 3, created: 0 })));
      expect(answer.ok && answer.value.results).toEqual([
        { rowNumber: 2, key: 'pack-size/g250', result: 'failed', code: 'import.group-not-applied' },
        { rowNumber: 3, key: 'pack-size/kg1', result: 'failed', code: 'import.group-not-applied' },
        { rowNumber: 4, key: 'pack-size/g100', result: 'failed', code: 'attribute.claim-word' },
      ]);
      expect(store.rows.get([...store.rows.keys()][1]!)!.state.version).toBe(1);

      const clean = [values, 'pack-size,g250,yes,250 g', 'pack-size,kg1,,1 kilo'].join('\n');
      const checkedClean = await build().check.execute(context(), { data: b64(clean) });
      const ran = await build().run.execute(context(), {
        data: b64(clean),
        ...tokens(checkedClean),
      });
      expect(ran).toEqual(
        ok(expect.objectContaining({ kind: 'values', created: 1, updated: 1, failed: 0 })),
      );
      const pack = [...store.rows.values()].find((d) => d.state.code === 'pack-size')!.state;
      expect(pack.version).toBe(2);
      expect(pack.options.map((o) => [o.code, o.labels[english], o.position])).toEqual([
        ['g500', '500 g', 0],
        ['kg1', '1 kilo', 1],
        ['g250', '250 g', 2],
      ]);
    });
  });
});
