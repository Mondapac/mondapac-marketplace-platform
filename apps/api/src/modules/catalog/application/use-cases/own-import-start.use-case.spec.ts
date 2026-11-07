import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerImportJob } from '../../domain/seller-import/seller-import-job';
import { SELLER_IMPORT_DAILY_ROWS } from '../../domain/rate-limits';
import {
  SellerImportAlreadyRunningError,
  type SellerImportRepository,
} from '../ports/seller-import.repository';
import { dailyRowsWaitSeconds, OwnImportStart } from './own-import-start.use-case';

// `own-import.start` in memory, on both Market fixtures (catalog design 14c): the start counter
// (5 a day), the daily row sum (10,000 across imports, with the seconds until enough has aged out),
// one queued or running import per seller (the check and the unique index), only the uploading
// account, and the audit row in the same unit.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-07T10:00:00Z');
const HOUR = 3_600_000;
const uuid = (n: number): string => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const JOB = uuid(0xc1);
const SELLER = uuid(0xb1) as Id<'Seller'>;
const ACCOUNT = uuid(0xa1) as Id<'Account'>;

describe('dailyRowsWaitSeconds', () => {
  const start = (hoursAgo: number, toImport: number) => ({
    startedAt: T0.subtract({ milliseconds: hoursAgo * HOUR }),
    toImport,
  });

  it('is null while the new rows fit under the cap', () => {
    expect(dailyRowsWaitSeconds([], 5000, T0)).toBeNull();
    expect(dailyRowsWaitSeconds([start(2, 5000)], 5000, T0)).toBeNull();
    expect(SELLER_IMPORT_DAILY_ROWS).toBe(10_000);
  });

  it('is the time until the earliest start that frees enough rows is 24 hours old', () => {
    // 6,000 + 4,000 started; 3,000 more need the first (6,000) to age out: 24 - 20 = 4 hours.
    expect(dailyRowsWaitSeconds([start(20, 6000), start(2, 4000)], 3000, T0)).toBe(4 * 3600);
    // 1,000 more fit after the second only if the first is not enough: 6000+4000=10000, +1000.
    expect(dailyRowsWaitSeconds([start(20, 1000), start(10, 9000)], 1000, T0)).toBe(4 * 3600);
    // Needs both to age out.
    expect(dailyRowsWaitSeconds([start(20, 5000), start(10, 5000)], 10_000, T0)).toBe(14 * 3600);
  });

  it('is at least one second and never negative', () => {
    expect(dailyRowsWaitSeconds([start(24, 10_000)], 1, T0)).toBe(1);
  });

  it('is the whole window when the file alone is over the cap', () => {
    expect(dailyRowsWaitSeconds([], 10_001, T0)).toBe(24 * 3600);
  });
});

describe.each(['AU', 'ZZ'] as const)('own-import.start in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  const contextOf = (
    account: Id<'Account'> = ACCOUNT,
    seller: Id<'Seller'> = SELLER,
  ): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: account,
        sessionId: uuid(0xa2) as Id<'Session'>,
        sellerId: seller,
      }),
    );

  interface Options {
    readonly job?: Partial<SellerImportJob> | null;
    readonly active?: boolean;
    readonly starts?: readonly { startedAt: Temporal.Instant; toImport: number }[];
    readonly eligible?: boolean;
    /** The counter answers: the count of the kind after this attempt. */
    readonly count?: number;
    readonly confirmThrows?: boolean;
    readonly confirmApplies?: boolean;
  }

  function rig(options: Options = {}) {
    const clock = new FixedClock(T0);
    const job =
      options.job === null
        ? null
        : ({
            id: JOB,
            sellerId: SELLER,
            startedByAccountId: ACCOUNT,
            mode: 'my-products',
            state: 'checked',
            totalRows: 10,
            readyRows: 8,
            errorRows: 2,
            warningRows: 0,
            groupCount: 8,
            format: 'csv',
            fileLabel: 'a.csv',
            ignoredColumns: [],
            skipErrors: null,
            toImport: null,
            createdRows: 0,
            updatedRows: 0,
            unchangedRows: 0,
            failedRows: 0,
            stopReason: null,
            fileDeletedAt: null,
            createdAt: T0,
            checkedAt: T0,
            startedAt: null,
            finishedAt: null,
            endedAt: null,
            version: 1,
            ...options.job,
          } as unknown as SellerImportJob);
    const confirmed: unknown[] = [];
    const audited: unknown[] = [];
    const reserved: string[] = [];
    const sellerJobs = {
      find: (_m: unknown, sellerId: Id<'Seller'>) =>
        Promise.resolve(sellerId === SELLER ? job : null),
      hasActive: () => Promise.resolve(options.active === true),
      startsSince: () => Promise.resolve(options.starts ?? []),
      confirm: (_m: unknown, _id: unknown, choice: unknown) => {
        if (options.confirmThrows === true)
          return Promise.reject(new SellerImportAlreadyRunningError());
        confirmed.push(choice);
        return Promise.resolve(options.confirmApplies !== false);
      },
    } as unknown as SellerImportRepository;
    const useCase = new OwnImportStart(gate, {
      unitOfWork: {
        run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
      } as unknown as UnitOfWork,
      sellerJobs,
      eligibility: { isEligible: () => Promise.resolve(options.eligible !== false) },
      counters: {
        reserve: (
          _m: MarketContext,
          list: readonly { limit: { kind: string; limit: number } }[],
        ) => {
          reserved.push(...list.map((counter) => counter.limit.kind));
          return Promise.resolve(
            list.map((counter) => ({
              kind: counter.limit.kind,
              count: options.count ?? 1,
              windowStartedAt: T0,
            })),
          );
        },
        purgeStartedBefore: () => Promise.resolve(0),
      } as never,
      counterKeys: { keyOf: () => new Uint8Array(32) } as never,
      audit: {
        record: (_c: unknown, entry: unknown) => (audited.push(entry), Promise.resolve()),
      } as unknown as AuditWriter,
      clock,
    });
    return { useCase, confirmed, audited, reserved };
  }
  const start = (r: ReturnType<typeof rig>, input: object = {}, context = contextOf()) =>
    r.useCase.execute(context, { importId: JOB, skipErrors: true, ...input } as never);

  it('confirms a checked job, counts the start, audits it and answers the queued job', async () => {
    const r = rig();
    const result = await start(r);
    expect(result).toMatchObject({ ok: true, value: { id: JOB, state: 'queued', toImport: 8 } });
    expect(r.reserved).toEqual(['import-start.seller.day']);
    expect(r.confirmed).toEqual([{ skipErrors: true, toImport: 8, now: T0 }]);
    expect(r.audited).toHaveLength(1);
  });

  it('answers request.throttled once the five starts of the day are spent, starting nothing', async () => {
    const r = rig({ count: 6 });
    const result = await start(r);
    expect(result).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
    expect(r.confirmed).toEqual([]);
  });

  it('refuses a second import while one is queued or running, and when the index refuses a race', async () => {
    expect(await start(rig({ active: true }))).toEqual({
      ok: false,
      error: { code: 'import.already-running' },
    });
    const raced = rig({ confirmThrows: true });
    expect(await start(raced)).toEqual({ ok: false, error: { code: 'import.already-running' } });
    expect(raced.audited).toEqual([]);
  });

  it('refuses the file that would pass 10,000 rows in 24 hours, with the wait it needs', async () => {
    const r = rig({
      starts: [
        { startedAt: T0.subtract({ milliseconds: 20 * HOUR }), toImport: 6000 },
        { startedAt: T0.subtract({ milliseconds: 2 * HOUR }), toImport: 3500 },
      ],
    });
    const result = await start(r);
    // 9,500 started; 8 more fit.
    expect(result.ok).toBe(true);
    const over = rig({
      job: { readyRows: 600, errorRows: 0, totalRows: 600 },
      starts: [
        { startedAt: T0.subtract({ milliseconds: 20 * HOUR }), toImport: 6000 },
        { startedAt: T0.subtract({ milliseconds: 2 * HOUR }), toImport: 3500 },
      ],
    });
    expect(await start(over)).toEqual({
      ok: false,
      error: { code: 'import.daily-rows-reached', retryAfterSeconds: 4 * 3600 },
    });
    expect(over.confirmed).toEqual([]);
  });

  it('asks for the choice about error rows, and refuses a file with nothing ready', async () => {
    expect(await start(rig(), { skipErrors: false })).toEqual({
      ok: false,
      error: { code: 'import.errors-not-skipped' },
    });
    expect(await start(rig({ job: { readyRows: 0, errorRows: 10 } }))).toEqual({
      ok: false,
      error: { code: 'import.nothing-to-import' },
    });
  });

  it('answers the same import.not-found for another account, another seller and an unknown id', async () => {
    const other = uuid(0xa9) as Id<'Account'>;
    const otherSeller = uuid(0xb9) as Id<'Seller'>;
    for (const context of [contextOf(other), contextOf(ACCOUNT, otherSeller)]) {
      expect(await start(rig(), {}, context)).toEqual({
        ok: false,
        error: { code: 'import.not-found' },
      });
    }
    expect(await start(rig({ job: null }))).toEqual({
      ok: false,
      error: { code: 'import.not-found' },
    });
  });

  it('refuses a job that is not checked, a seller who may not sell and a malformed request', async () => {
    expect(await start(rig({ job: { state: 'queued' } }))).toEqual({
      ok: false,
      error: { code: 'import.not-confirmable' },
    });
    expect(await start(rig({ eligible: false }))).toEqual({
      ok: false,
      error: { code: 'seller.not-eligible' },
    });
    expect(await start(rig(), { skipErrors: 'yes' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await start(rig(), { importId: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
  });
});
