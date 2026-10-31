import { createHash } from 'node:crypto';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type {
  AttributeField,
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
import type { AuthorisationCheck , JobCallContexts} from '../../../../platform/authz';
import { type AdminJobContext } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { StoredCategoryNode } from '../../domain/category-tree';
import type {
  ImportJob,
  ImportRowRecord,
  StopReason,
} from '../../domain/platform-import/platform-import-job';
import { configurableProductType } from '../../domain/product-types/configurable';
import { simpleProductType } from '../../domain/product-types/simple';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ImportFileStore } from '../ports/import-file-store';
import type { PlatformImportRepository } from '../ports/platform-import.repository';
import { PlatformImportRun } from './platform-import-run.use-case';

// `platform-import.run` in memory on both Market fixtures (catalog design 14a): the rows go through
// the platform product use cases as the admin who started the import, an Inactive start pauses,
// a refused text fails only its row, a lost permission stops the import, and a throttled row waits.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');
const uuid = (n: number): string => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const idOf = <K extends string>(n: number): Id<K> => {
  const parsed = parseId<K>(uuid(n));
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
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

const FILE = [
  'Title,Main category,Product type,Description,Brand,Barcode (GTIN),Unit size,Image URL',
  'Lamb,Meat,simple,Shoulder,Farms,,,',
  'Beef,Meat,simple,,Farms,,,',
  'Pork,Nowhere,simple,,Farms,,,',
].join('\n');

describe.each(['AU', 'ZZ'] as const)('platform-import.run in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locale = policy.locales(market).default;

  type SaveScript = (
    call: number,
  ) => Result<{ refusedFields: { code: string }[] }, { code: string }>;

  function rig(
    options: {
      startAs?: 'inactive' | 'active';
      save?: SaveScript;
      submit?: (
        call: number,
      ) => Result<{ published: boolean }, { code: string; retryAfterSeconds?: number }>;
      adminGone?: boolean;
      fileBytes?: Buffer;
    } = {},
  ) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const bytes = options.fileBytes ?? Buffer.from(FILE);
    const accountId = ids.next<'Account'>();
    const sessionId = ids.next<'Session'>();
    const importId = idOf<'PlatformImport'>(900);
    const job: ImportJob = {
      id: importId,
      state: 'queued',
      startedByAccountId: accountId,
      startedBySessionId: sessionId,
      format: 'csv',
      fileLabel: 'a.csv',
      fileKey: 'catalog/imports/x',
      fileSha256: createHash('sha256').update(bytes).digest('hex'),
      fileBytes: bytes.length,
      totalRows: 3,
      readyRows: 2,
      errorRows: 1,
      warningRows: 0,
      ignoredColumns: [],
      startAs: options.startAs ?? 'inactive',
      skipErrors: true,
      toImport: 2,
      addedRows: 0,
      failedRows: 0,
      stopReason: null,
      notBefore: null,
      leaseUntil: null,
      createdAt: T0,
      checkedAt: T0,
      startedAt: T0,
      finishedAt: null,
      fileDeletedAt: null,
      version: 2,
    } as unknown as ImportJob;
    const rows: ImportRowRecord[] = [
      {
        rowNumber: 2,
        checkState: 'ready',
        issues: [],
        summary: { title: 'Lamb', category: 'Meat', typeCode: 'simple', brand: 'Farms' },
        runState: 'pending',
        runCode: null,
        productId: null,
        productCode: null,
      },
      {
        rowNumber: 3,
        checkState: 'ready',
        issues: [],
        summary: { title: 'Beef', category: 'Meat', typeCode: 'simple', brand: 'Farms' },
        runState: 'pending',
        runCode: null,
        productId: null,
        productCode: null,
      },
      {
        rowNumber: 4,
        checkState: 'error',
        issues: [],
        summary: { title: 'Pork', category: 'Nowhere', typeCode: 'simple', brand: 'Farms' },
        runState: 'skipped',
        runCode: null,
        productId: null,
        productCode: null,
      },
    ];
    const events: unknown[] = [];
    let end: { state: string; reason?: StopReason } | null = null;
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const importJobs = {
      claim: () => Promise.resolve(end === null && job.state === 'queued' ? job : null),
      renewLease: () => Promise.resolve(true),
      pendingRows: () =>
        Promise.resolve(
          rows.filter((row) => row.runState === 'pending' && row.checkState === 'ready'),
        ),
      recordProduct: (
        _m: MarketContext,
        _id: unknown,
        rowNumber: number,
        p: { productId: string; productCode: string },
      ) => {
        const row = rows.find((candidate) => candidate.rowNumber === rowNumber)!;
        Object.assign(row, p);
        return Promise.resolve();
      },
      settleRow: (
        _m: MarketContext,
        _id: unknown,
        rowNumber: number,
        outcome: { state: 'added' | 'failed'; code?: string },
      ) => {
        const row = rows.find((candidate) => candidate.rowNumber === rowNumber)!;
        Object.assign(row, { runState: outcome.state, runCode: outcome.code ?? null });
        const mutable = job as { addedRows: number; failedRows: number };
        if (outcome.state === 'added') mutable.addedRows += 1;
        else mutable.failedRows += 1;
        return Promise.resolve();
      },
      endTurn: (_m: MarketContext, _id: unknown, next: { state: string; reason?: StopReason }) => {
        end = next;
        return Promise.resolve(3);
      },
      find: () => Promise.resolve(job),
    } as unknown as PlatformImportRepository;
    const importFiles: ImportFileStore = {
      keyOf: () => 'k',
      put: () => Promise.resolve(),
      get: () => Promise.resolve(bytes),
      delete: () => Promise.resolve(),
    };
    const nodes: StoredCategoryNode[] = [
      {
        id: idOf<'Category'>(1),
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

    const calls: string[] = [];
    const created: string[] = [];
    const saves: unknown[] = [];
    let saveCalls = 0;
    let submitCalls = 0;
    const platformCreate = {
      execute: () => {
        const n = created.length + 1;
        created.push(`p${n}`);
        calls.push('create');
        return Promise.resolve({
          ok: true,
          value: { productId: uuid(100 + n), productCode: `P${n}`, variantIds: [uuid(200 + n)] },
        });
      },
    };
    const platformSaveDraft = {
      execute: (_c: unknown, input: unknown) => {
        calls.push('save');
        saves.push(input);
        saveCalls += 1;
        return Promise.resolve(
          options.save?.(saveCalls) ?? { ok: true, value: { refusedFields: [] } },
        );
      },
    };
    const platformSubmit = {
      execute: () => {
        calls.push('submit');
        submitCalls += 1;
        return Promise.resolve(
          options.submit?.(submitCalls) ?? { ok: true, value: { published: true } },
        );
      },
    };
    const pause = {
      execute: () => {
        calls.push('pause');
        return Promise.resolve({ ok: true, value: {} });
      },
    };
    const outbox: OutboxWriter = {
      append: (_c, list) => {
        events.push(...list);
        return Promise.resolve();
      },
    };
    const systemContext = testCallContext(market, 'system');
    const adminContext = testCallContext(
      market,
      testAuthenticatedActor(market, { population: 'admin', accountId, sessionId, sellerId: null }),
    ) as AdminJobContext;
    const jobContexts = {
      asAdmin: () => Promise.resolve(options.adminGone === true ? null : adminContext),
    } as unknown as JobCallContexts;
    const useCase = new PlatformImportRun(gate, {
      unitOfWork,
      importJobs,
      importFiles,
      products: { findById: () => Promise.resolve(null) } as never,
      outbox,
      clock,
      jobContexts,
      platformCreate: platformCreate as never,
      platformSaveDraft: platformSaveDraft as never,
      platformSubmit: platformSubmit as never,
      pause: pause as never,
      treeReader,
      attributes,
      policy,
      productTypes: (typeCode) => handlers[typeCode as keyof typeof handlers],
    });
    return {
      useCase,
      job,
      rows,
      events,
      calls,
      saves,
      systemContext: systemContext,
      ended: () => end,
    };
  }

  it('creates, saves, submits and pauses each ready row for Inactive; the error row is not tried', async () => {
    const r = rig();
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toEqual({
      ok: true,
      value: { ran: true, outcome: 'finished', added: 2, failed: 0 },
    });
    expect(r.calls).toEqual([
      'create',
      'save',
      'submit',
      'pause',
      'create',
      'save',
      'submit',
      'pause',
    ]);
    expect(r.rows.map((row) => row.runState)).toEqual(['added', 'added', 'skipped']);
    expect(r.ended()).toEqual({ state: 'finished', now: T0 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type: 'catalog.platform-import-finished.v1',
      payload: { outcome: 'completed', added: 2, failed: 0 },
    });
  });

  it('leaves products published for Active (no pause)', async () => {
    const r = rig({ startAs: 'active' });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.calls).not.toContain('pause');
    expect(r.rows.filter((row) => row.runState === 'added')).toHaveLength(2);
  });

  it('saves only content: no handling, attestation or tag reaches the draft', async () => {
    const r = rig();
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    const saved = r.saves[0] as { content: Record<string, unknown> };
    expect(Object.keys(saved.content).sort()).toEqual([
      'attributeValues',
      'categoryIds',
      'imageIds',
      'taxCategoryCode',
      'texts',
    ]);
  });

  it('fails only the row whose text the claim control refused', async () => {
    const r = rig({
      save: (call) =>
        call === 1
          ? { ok: true, value: { refusedFields: [{ code: 'claim-text.found' }] } }
          : { ok: true, value: { refusedFields: [] } },
    });
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toMatchObject({ ok: true, value: { outcome: 'finished', added: 1, failed: 1 } });
    expect(r.rows.map((row) => [row.runState, row.runCode])).toEqual([
      ['failed', 'claim-text.found'],
      ['added', null],
      ['skipped', null],
    ]);
  });

  it('stops with access-lost when the admin is no longer an admin, trying no row', async () => {
    const r = rig({ adminGone: true });
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toMatchObject({ ok: true, value: { outcome: 'stopped' } });
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'access-lost' });
    expect(r.calls).toHaveLength(0);
    expect(r.events[0]).toMatchObject({ payload: { outcome: 'stopped' } });
  });

  it('stops with access-lost when a use case refuses the admin mid-run, keeping the earlier rows', async () => {
    const r = rig({
      submit: (call) =>
        call === 1
          ? { ok: true, value: { published: true } }
          : { ok: false, error: { code: 'access.denied' } },
    });
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toMatchObject({ ok: true, value: { outcome: 'stopped', added: 1 } });
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'access-lost' });
    expect(r.rows[0]!.runState).toBe('added');
    expect(r.rows[1]!.runState).toBe('pending');
  });

  it('waits out a short rate window and goes back to the queue', async () => {
    const r = rig({
      submit: () => ({ ok: false, error: { code: 'request.throttled', retryAfterSeconds: 30 } }),
    });
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toMatchObject({ ok: true, value: { outcome: 'queued' } });
    expect(r.ended()).toMatchObject({ state: 'queued', notBefore: T0.add({ seconds: 30 }) });
    expect(r.events).toHaveLength(0);
  });

  it('stops with rate-limited when the window is a long one (the daily limit)', async () => {
    const r = rig({
      submit: () => ({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 40_000 },
      }),
    });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'rate-limited' });
  });

  it('stops with file-missing when the stored file is not the one that was checked', async () => {
    const r = rig();
    (r.job as { fileSha256: string }).fileSha256 = 'f'.repeat(64);
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'file-missing' });
    expect(r.calls).toHaveLength(0);
  });

  it('refuses to run for a person: it is a system use case', async () => {
    const r = rig();
    const person = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: idOf<'Account'>(5),
        sessionId: idOf<'Session'>(6),
        sellerId: null,
      }),
    );
    const result = await r.useCase.execute(person, { budgetMs: 60_000 });
    expect(result.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
  });
});
