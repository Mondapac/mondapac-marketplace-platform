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
  const fileOf = (groups: number): string =>
    [
      'Seller SKU,Condition,Title,Main category,Product type,Price,Stock',
      ...Array.from(
        { length: groups },
        (_, index) => `SKU-${index + 1},${condition},Lamb ${index + 1},Meat,simple,9.99,5`,
      ),
    ].join('\n');
  const FILE = fileOf(1);

  function rig(
    options: {
      sellerGone?: boolean;
      /** What `sellers` answers about the seller (default `eligible`). */
      eligibility?: 'eligible' | 'not-eligible' | 'unavailable';
      /**
       * The seller is suspended once the job has resumed its identity this many times: the session
       * is revoked (the resume answers null) and `sellers` answers not-eligible, as a real suspension.
       */
      suspendedAfterResumes?: number;
      /** The file lists this many groups (default one); more than a batch spans turns. */
      groups?: number;
      /** The seller already has an Offer on the SKUs (an update, not a create). */
      existing?: boolean;
      /** What the row save reports for an update: nothing changed, or something did. */
      saveUnchanged?: boolean;
      /** The gate refuses the row use cases (the account lost a key, or the session is revoked). */
      rowGateDenied?: boolean;
      /** The job started this long ago (the bound on a fault that keeps coming back). */
      startedHoursAgo?: number;
      /** The store fails when the batch is read (a fault outside any group). */
      throwOnPending?: boolean;
      /** Rows already carry the ids a former attempt remembered. */
      recorded?: boolean;
      fileBytes?: Buffer | null;
      storedHash?: string;
      claimed?: boolean;
    } = {},
  ) {
    const clock = new FixedClock(T0);
    const groupCount = options.groups ?? 1;
    const file = fileOf(groupCount);
    const bytes = options.fileBytes === undefined ? Buffer.from(file) : options.fileBytes;
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
      fileSha256: options.storedHash ?? createHash('sha256').update(file).digest('hex'),
      fileBytes: file.length,
      totalRows: groupCount,
      readyRows: groupCount,
      errorRows: 0,
      warningRows: 0,
      groupCount,
      ignoredColumns: [],
      skipErrors: false,
      toImport: groupCount,
      createdRows: 0,
      updatedRows: 0,
      unchangedRows: 0,
      failedRows: 0,
      stopReason: null,
      notBefore: null,
      leaseUntil: null,
      createdAt: T0,
      checkedAt: T0,
      startedAt: T0.subtract({ hours: options.startedHoursAgo ?? 0 }),
      finishedAt: null,
      endedAt: null,
      fileDeletedAt: null,
      version: 2,
    } as unknown as SellerImportJob;
    const rows: SellerRowRecord[] = Array.from({ length: groupCount }, (_, index) => ({
      rowNumber: index + 2,
      groupRow: index + 2,
      checkState: 'ready' as const,
      plan: options.existing === true ? ('update' as const) : ('create' as const),
      issues: [],
      summary: {
        sku: `SKU-${index + 1}`,
        title: `Lamb ${index + 1}`,
        productCode: '',
        typeCode: 'simple',
        options: '',
        images: [],
      },
      runState: 'pending' as const,
      runCode: null,
      productId: options.recorded === true ? uuid(101 + index * 10) : null,
      offerId: options.recorded === true ? uuid(102 + index * 10) : null,
      productCode: options.recorded === true ? `P${index + 1}` : null,
    }));
    const settled: {
      groupRow: number;
      outcome: { state: string; productId?: string | null; offerId?: string | null };
    }[] = [];
    const events: unknown[] = [];
    let end: { state: string; reason?: SellerStopReason } | null = null;
    let failedRemaining: string | null = null;
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const sellerJobs = {
      claim: () => Promise.resolve(options.claimed === false ? null : job),
      renewLease: () => Promise.resolve(true),
      pendingRows: (_m: unknown, _id: unknown, limit: number) =>
        options.throwOnPending === true
          ? Promise.reject(new Error('store down'))
          : Promise.resolve(
              rows
                .filter((row) => row.runState === 'pending' && row.checkState === 'ready')
                .slice(0, limit),
            ),
      recordGroup: () => Promise.resolve(),
      settleGroup: (
        _m: MarketContext,
        _id: unknown,
        group: number,
        outcome: {
          state: SellerRowRecord['runState'];
          code?: string;
          productId?: string | null;
          offerId?: string | null;
          productCode?: string | null;
        },
      ) => {
        settled.push({ groupRow: group, outcome });
        for (const row of rows.filter((candidate) => candidate.groupRow === group)) {
          Object.assign(row, {
            runState: outcome.state,
            runCode: outcome.code ?? null,
            // As the store does: a null id keeps what was recorded.
            productId: outcome.productId ?? row.productId,
            offerId: outcome.offerId ?? row.offerId,
            productCode: outcome.productCode ?? row.productCode,
          });
        }
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
        if (options.rowGateDenied === true) {
          return Promise.resolve({ ok: false, error: { code: 'access.denied' } });
        }
        return Promise.resolve({
          ok: true,
          value: { variantIds: [uuid(103)], unchanged: options.saveUnchanged === true },
        });
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
    const suspended = (): boolean =>
      options.suspendedAfterResumes !== undefined &&
      asSellerCalls.length > options.suspendedAfterResumes;
    const jobContexts = {
      asSeller: (_c: unknown, identity: unknown) => {
        asSellerCalls.push(identity);
        return Promise.resolve(options.sellerGone === true || suspended() ? null : sellerContext);
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
            offersBySku:
              options.existing === true
                ? new Map(
                    Array.from({ length: groupCount }, (_, index) => [
                      `SKU-${index + 1}`,
                      {
                        offerId: uuid(202 + index * 10),
                        productId: uuid(201 + index * 10),
                        productCode: `E${index + 1}`,
                        sellerSku: `SKU-${index + 1}`,
                        productScope: 'SELLER' as const,
                        productTypeCode: 'simple',
                        variants: [{ variantId: uuid(203 + index * 10), optionKey: '' }],
                        publishedAxes: null,
                      },
                    ]),
                  )
                : new Map(),
            ownSkuByProductId: new Map(),
            catalogueByCode: new Map(),
          }),
      },
      eligibilityStatus: {
        status: () =>
          Promise.resolve(suspended() ? 'not-eligible' : (options.eligibility ?? 'eligible')),
      },
      allowedTypes: { allowedFor: () => Promise.resolve('all') },
      offers: {
        // The stored Offer has the condition and no description the file would change.
        findById: () =>
          Promise.resolve({
            state: { sellerSku: 'SKU-1', conditionCode: condition, description: {} },
          }),
      } as never,
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
      settled,
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
    const kept = {
      accountId: idOf<'Account'>(0xa1),
      sessionId: idOf<'Session'>(0xa2),
      sellerId: idOf<'Seller'>(0xb1),
    };
    // At the start of the turn and for the batch.
    expect(r.asSellerCalls).toEqual([kept, kept]);
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
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'access-lost' });
    expect(r.calls).toEqual([]);
    expect(r.events[0]).toMatchObject({ payload: { outcome: 'stopped' } });
  });

  it('stops with seller-not-eligible, not access-lost, when a suspension revoked the session', async () => {
    // Realistic: the suspension revokes the sessions, so the identity cannot be resumed at all, and
    // `sellers` says the seller may not sell. The reason is the seller's state, not a lost account.
    const r = rig({ sellerGone: true, eligibility: 'not-eligible' });
    const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(result).toMatchObject({ ok: true, value: { ran: true, outcome: 'stopped' } });
    expect(r.failedRemaining()).toBe('seller.not-eligible');
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'seller-not-eligible' });
    expect(r.calls).toEqual([]);
    expect(r.rows[0]).toMatchObject({ runState: 'failed', runCode: 'seller.not-eligible' });
  });

  it('fails the rest and stops when the seller is suspended in the middle of a job', async () => {
    // 25 groups are two batches: the first runs, then the suspension revokes the session.
    const r = rig({ groups: 25, suspendedAfterResumes: 2 });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.rows.filter((row) => row.runState === 'created')).toHaveLength(20);
    expect(r.rows.filter((row) => row.runCode === 'seller.not-eligible')).toHaveLength(5);
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'seller-not-eligible' });
  });

  it('stops with seller-not-eligible when a row use case is refused for a suspended seller', async () => {
    // The session is still good when the batch starts; the gate refuses the row save as the keys go.
    const r = rig({ existing: true, rowGateDenied: true, suspendedAfterResumes: 1 });
    // The first resume works and the refusal then arrives from the gate; `sellers` says not-eligible.
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'seller-not-eligible' });
    expect(r.failedRemaining()).toBe('seller.not-eligible');
  });

  it('stops with access-lost when only the account is gone and the seller may sell', async () => {
    const r = rig({ sellerGone: true, eligibility: 'eligible' });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'access-lost' });
  });

  it('keeps access-lost for a refused row use case when the seller may still sell', async () => {
    const r = rig({ existing: true, rowGateDenied: true });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'access-lost' });
    expect(r.failedRemaining()).toBeNull();
  });

  it('waits and tries again, never stops, when the eligibility cannot be read', async () => {
    // At the start (no identity to resume), and with the identity resumed.
    for (const options of [
      { sellerGone: true, eligibility: 'unavailable' as const },
      { eligibility: 'unavailable' as const },
    ]) {
      const r = rig(options);
      const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
      expect(result).toMatchObject({ ok: true, value: { ran: true, outcome: 'queued' } });
      expect(r.ended()).toMatchObject({ state: 'queued' });
      expect(r.failedRemaining()).toBeNull();
      expect(r.calls).toEqual([]);
    }
  });

  it('asks who the job runs as again at every batch', async () => {
    const r = rig({ groups: 45 });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.ended()).toMatchObject({ state: 'finished' });
    // One at the start of the turn and one for each of the three batches (20 + 20 + 5 groups).
    expect(r.asSellerCalls).toHaveLength(4);
  });

  it('settles an updated row with the product, Offer and code it found', async () => {
    const r = rig({ existing: true });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    // Update path: no create, the draft is saved over the stored one.
    expect(r.calls).toEqual(['save']);
    expect(r.settled).toEqual([
      {
        groupRow: 2,
        outcome: {
          state: 'updated',
          productId: uuid(201),
          offerId: uuid(202),
          productCode: 'E1',
        },
      },
    ]);
    expect(r.rows[0]).toMatchObject({ runState: 'updated', offerId: uuid(202) });
    expect(r.ended()).toMatchObject({ state: 'finished' });
  });

  it('settles an unchanged row with its ids too, and counts nothing as changed', async () => {
    const r = rig({ existing: true, saveUnchanged: true });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    expect(r.settled[0]!.outcome).toEqual({
      state: 'unchanged',
      productId: uuid(201),
      offerId: uuid(202),
      productCode: 'E1',
    });
  });

  it('settles a crash-recovered group with the ids a former attempt remembered', async () => {
    const r = rig({ recorded: true });
    await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
    // The product exists already: no second create, only the save, and the ids ride along.
    expect(r.calls).toEqual(['save']);
    expect(r.settled[0]!.outcome).toMatchObject({
      state: 'created',
      productId: uuid(101),
      offerId: uuid(102),
    });
  });

  it('ends a job that keeps failing unexpectedly after the bound, and requeues it before', async () => {
    for (const [ageHours, expected] of [
      [1, { state: 'queued' }],
      [25, { state: 'stopped', reason: 'unexpected' }],
    ] as const) {
      const r = rig({ startedHoursAgo: ageHours, throwOnPending: true });
      const result = await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
      expect(result).toMatchObject({ ok: true, value: { ran: true } });
      expect(r.ended()).toMatchObject(expected);
    }
  });

  it('stops with file-missing when the stored file is gone or is not the one that was checked', async () => {
    for (const options of [{ fileBytes: null }, { fileBytes: Buffer.from(`${FILE}\nSKU-2`) }]) {
      const r = rig(options);
      await r.useCase.execute(r.systemContext, { budgetMs: 60_000 });
      expect(r.ended()).toMatchObject({ state: 'stopped', reason: 'file-missing' });
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
