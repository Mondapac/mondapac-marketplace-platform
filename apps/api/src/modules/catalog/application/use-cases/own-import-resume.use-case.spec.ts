import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
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
import type { SellerImportJob } from '../../domain/seller-import/seller-import-job';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import { OwnImportResume } from './own-import-resume.use-case';

// `own-import.resume` in memory, on both Market fixtures (catalog design 14c): a job stopped for a
// lost identity is not resumable (`import.access-lost`), any other stopped job is.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const T0 = Temporal.Instant.from('2026-11-07T10:00:00Z');
const uuid = (n: number): string => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const JOB = uuid(0xc1);
const SELLER = uuid(0xb1) as Id<'Seller'>;
const ACCOUNT = uuid(0xa1) as Id<'Account'>;

describe.each(['AU', 'ZZ'] as const)('own-import.resume in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ACCOUNT,
      sessionId: uuid(0xa2) as Id<'Session'>,
      sellerId: SELLER,
    }),
  );

  function rig(stopReason: string) {
    const resumed: string[] = [];
    const job = {
      id: JOB,
      sellerId: SELLER,
      startedByAccountId: ACCOUNT,
      mode: 'my-products',
      format: 'csv',
      state: 'stopped',
      stopReason,
      fileDeletedAt: null,
      version: 4,
      totalRows: 1,
      readyRows: 1,
      errorRows: 0,
      warningRows: 0,
      groupCount: 1,
      ignoredColumns: [],
      createdRows: 0,
      updatedRows: 0,
      unchangedRows: 0,
      failedRows: 0,
      toImport: 1,
      skipErrors: false,
      fileLabel: 'a.csv',
      createdAt: T0,
      checkedAt: T0,
      startedAt: T0,
      finishedAt: null,
      endedAt: T0,
    } as unknown as SellerImportJob;
    const useCase = new OwnImportResume(createUseCaseGate(markets, admitAll), {
      unitOfWork: {
        run: async <T>(_m: MarketContext, work: () => Promise<T>) => work(),
      } as unknown as UnitOfWork,
      sellerJobs: {
        find: () => Promise.resolve(job),
        hasActive: () => Promise.resolve(false),
        resume: (_m: unknown, id: string) => {
          resumed.push(id);
          return Promise.resolve(true);
        },
      } as unknown as SellerImportRepository,
      eligibility: { isEligible: () => Promise.resolve(true) },
      clock: new FixedClock(T0),
    });
    return { useCase, resumed };
  }

  it('refuses a job stopped for a lost identity and resumes nothing', async () => {
    const r = rig('access-lost');
    expect(await r.useCase.execute(context, { importId: JOB })).toEqual({
      ok: false,
      error: { code: 'import.access-lost' },
    });
    expect(r.resumed).toEqual([]);
  });

  it.each(['rate-limited', 'unexpected'])('resumes a job stopped for %s', async (reason) => {
    const r = rig(reason);
    expect(await r.useCase.execute(context, { importId: JOB })).toMatchObject({
      ok: true,
      value: { state: 'queued' },
    });
    expect(r.resumed).toEqual([JOB]);
  });
});
