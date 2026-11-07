import { createHash } from 'node:crypto';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type {
  AuthorisationCheck,
  JobCallContexts,
  SellerJobContext,
} from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { StoredCategoryNode } from '../../domain/category-tree';
import { csvParser } from '../../domain/platform-import/import-file';
import { simpleProductType } from '../../domain/product-types/simple';
import type {
  SellerImportJob,
  SellerRowRecord,
  SellerStopReason,
} from '../../domain/seller-import/seller-import-job';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { ImportFileStore } from '../ports/import-file-store';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import { OwnImportRun } from './own-import-run.use-case';

// `own-import.run` in memory on both Market fixtures (catalog design 14c): the work is done as the
// seller who started the import; a lost account, a seller who can no longer sell and a changed file
// each stop the job with their own reason; nothing but create and save is ever called (no submit,
// no tag, no price, no stock), and the finish writes one event.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const uuid = (n: number): string => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const idOf = <K extends string>(n: number): Id<K> => {
  const parsed = parseId<K>(uuid(n));
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each(['AU', 'ZZ'] as const)('own-import.run in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locale = policy.locales(market).default;
  const condition = policy.conditions(market)[0]!;
  const FILE = [
    'Seller SKU,Condition,Title,Main category,Product type,Price,Stock',
    `SKU-1,${condition},Lamb,Meat,simple,9.99,5`,
  ].join('\n');

  function rig(
    options: {
      sellerGone?: boolean;
      eligible?: boolean;
      fileBytes?: Buffer | null;
      storedHash?: string;
      claimed?: boolean;
    } = {},
  ) {
    const clock = new FixedClock(T0);
    const bytes = options.fileBytes === undefined ? Buffer.from(FILE) : options.fileBytes;
    const sellerId = idOf<'Seller'>(0xb1);
    const accountId = idOf<'Account'>(0xa1);
    const sessionId = idOf<'Session'>(0xa2);
    const job = {
      id: idOf<'SellerImport'>(900),
      sellerId,
      startedByAccountId: accountId,
      startedBySessionId: sessionId,
      mode: 'my-products',
      state: 'queued',
      format: 'csv',
      fileLabel: 'a.csv',
      fileKey: 'catalog/seller-imports/x',
      fileSha256: options.storedHash ?? createHash('sha256').update(FILE).digest('hex'),
      fileBytes: FILE.length,
      totalRows: 1,
      readyRows: 1,
      errorRows: 0,
      warningRows: 0,
      groupCount: 1,
      ignoredColumns: [],
      skipErrors: false,
      toImport: 1,
      createdRows: 0,
      updatedRows: 0,
      unchangedRows: 0,
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
    } as unknown as SellerImportJob;
    const rows: SellerRowRecord[] = [
      {
        rowNumber: 2,
        groupRow: 2,
        checkState: 'ready',
        plan: 'create',
        issues: [],
        summary: {
          sku: 'SKU-1',
          title: 'Lamb',
          productCode: '',
          typeCode: 'simple',
          options: '',
          images: [],
        },
        runState: 'pending',
        runCode: null,
        productId: null,
        offerId: null,
        productCode: null,
      },
    ];
    const events: unknown[] = [];
    let end: { state: string; reason?: SellerStopReason } | null = null;
    let failedRemaining: string | null = null;
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const sellerJobs = {
      claim: () => Promise.resolve(options.claimed === false ? null : job),
      renewLease: () => Promise.resolve(true),
      pendingRows: () =>
        Promise.resolve(
          rows.filter((row) => row.runState === 'pending' && row.checkState === 'ready'),
        ),
      recordGroup: () => Promise.resolve(),
      settleGroup: (
        _m: MarketContext,
        _id: unknown,
        _group: number,
        outcome: { state: SellerRowRecord['runState']; code?: string },
      ) => {
        for (const row of rows)
          Object.assign(row, { runState: outcome.state, runCode: outcome.code ?? null });
        return Promise.resolve();
      },
      failRemaining: (_m: MarketContext, _id: unknown, reason: string) => {
        failedRemaining = reason;
        for (const row of rows) {
          if (row.runState === 'pending')
            Object.assign(row, { runState: 'failed', runCode: reason });
        }
        return Promise.resolve();
      },
      endTurn: (
        _m: MarketContext,
        _id: unknown,
        next: { state: string; reason?: SellerStopReason },
      ) => {
        end = next;
        return Promise.resolve(3);
      },
      find: () => Promise.resolve(job),
    } as unknown as SellerImportRepository;
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
        position: 0,
        names: [{ locale, name: 'Meat' }],
      },
    ];
    const calls: string[] = [];
    const createInputs: unknown[] = [];
    const saveInputs: unknown[] = [];
    const ownRowCreate = {
      execute: (_c: unknown, input: unknown) => {
        calls.push('create');
        createInputs.push(input);
        return Promise.resolve({
          ok: true,
          value: {
            productId: uuid(101),
            productCode: 'P1',
            offerId: uuid(102),
            variantIds: [uuid(103)],
          },
        });
      },
    };
    const ownRowSave = {
      execute: (_c: unknown, input: unknown) => {
        calls.push('save');
        saveInputs.push(input);
        return Promise.resolve({ ok: true, value: { variantIds: [uuid(103)], unchanged: false } });
      },
    };
    const outbox: OutboxWriter = {
      append: (_c, list) => {
        events.push(...list);
        return Promise.resolve();
      },
    };
    const sellerContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId,
        sellerId,
      }),
    ) as unknown as SellerJobContext;
    const asSellerCalls: unknown[] = [];
    const jobContexts = {
      asSeller: (_c: unknown, identity: unknown) => {
        asSellerCalls.push(identity);
        return Promise.resolve(options.sellerGone === true ? null : sellerContext);
      },
    } as unknown as JobCallContexts;
    const useCase = new OwnImportRun(gate, {
      unitOfWork,
      sellerJobs,
      importFiles,
      importParsers: [csvParser],
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
      offers: { findById: () => Promise.resolve(null) } as never,
      outbox,
      clock,
      jobContexts,
      ownRowCreate: ownRowCreate as never,
      ownRowSave: ownRowSave as never,
      ownRowOfferCreate: { execute: () => Promise.reject(new Error('not used')) } as never,
      ownRowOfferEdit: { execute: () => Promise.reject(new Error('not used')) } as never,
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
      policy,
      productTypes: (typeCode) => (typeCode === 'simple' ? simpleProductType : undefined),
    });
    return {
      useCase,
      rows,
      events,
      calls,
      createInputs,
      saveInputs,
      asSellerCalls,
      systemContext: testCallContext(market, 'system'),
      ended: () => end,
      failedRemaining: () => failedRemaining,
    };
  }

  it('does nothing when no import is due', async () => {
    const r = rig({ claimed: false });
    expect(await r.useCase.execute(r.systemContext, { budgetMs: 60_000 })).toEqual({
      ok: true,
      value: { ran: false },
    });
    expect(r.calls).toEqual([]);
  });

  it('creates and saves a ready row as the seller who started it, and writes one event', async () => {
    const r = rig();
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toMatchObject({ ok: true, value: { ran: true, outcome: 'finished' } });
    // The kept identity of the job is what is resumed, nothing else.
    expect(r.asSellerCalls).toEqual([
      {
        accountId: idOf<'Account'>(0xa1),
        sessionId: idOf<'Session'>(0xa2),
        sellerId: idOf<'Seller'>(0xb1),
      },
    ]);
    // Only create and save: no submit, no publish, no tag, no price or stock.
    expect(r.calls).toEqual(['create', 'save']);
    expect(Object.keys(r.createInputs[0] as object).sort()).toEqual([
      'conditionCode',
      'description',
      'sellerSku',
      'typeCode',
    ]);
    expect(JSON.stringify([r.createInputs, r.saveInputs])).not.toMatch(/9\.99/);
    expect(r.rows[0]).toMatchObject({ runState: 'created' });
    expect(r.ended()).toMatchObject({ state: 'finished' });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type: 'catalog.seller-import-finished.v1',
      payload: { outcome: 'completed' },
    });
  });

  it('stops with access-lost when the account is no longer an active member, trying no row', async () => {
    const r = rig({ sellerGone: true });
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toMatchObject({ ok: true, value: { ran: true, outcome: 'stopped' } });
    expect(r.ended()).toEqual({ state: 'stopped', reason: 'access-lost' });
    expect(r.calls).toEqual([]);
    expect(r.events[0]).toMatchObject({ payload: { outcome: 'stopped' } });
  });

  it('fails the rest and stops when the seller can no longer sell (suspended mid-job)', async () => {
    const r = rig({ eligible: false });
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toMatchObject({ ok: true, value: { ran: true, outcome: 'stopped' } });
    expect(r.failedRemaining()).toBe('seller.not-eligible');
    expect(r.ended()).toEqual({ state: 'stopped', reason: 'seller-not-eligible' });
    expect(r.calls).toEqual([]);
    expect(r.rows[0]).toMatchObject({ runState: 'failed', runCode: 'seller.not-eligible' });
  });

  it('stops with file-missing when the stored file is gone or is not the one that was checked', async () => {
    for (const options of [{ fileBytes: null }, { fileBytes: Buffer.from(`${FILE}\nSKU-2`) }]) {
      const r = rig(options);
      await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
      expect(r.ended()).toEqual({ state: 'stopped', reason: 'file-missing' });
      expect(r.calls).toEqual([]);
    }
  });

  it('runs only as the system actor', async () => {
    const r = rig();
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: idOf<'Account'>(0xa1),
        sessionId: idOf<'Session'>(0xa2),
        sellerId: idOf<'Seller'>(0xb1),
      }),
    );
    expect(await r.useCase.execute(seller, { budgetMs: 60_000 })).toMatchObject({ ok: false });
    expect(r.calls).toEqual([]);
  });
});
