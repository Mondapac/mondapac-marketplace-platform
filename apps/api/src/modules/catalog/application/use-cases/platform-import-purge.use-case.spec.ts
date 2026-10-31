import { Temporal } from '@mondapac/shared-kernel';
import type { Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ImportFileStore } from '../ports/import-file-store';
import type { PlatformImportRepository } from '../ports/platform-import.repository';
import {
  PlatformImportPurge,
  PURGE_BATCH,
  PURGE_BUDGET_MS,
} from './platform-import-purge.use-case';

// The purge of the platform import (catalog data design 10.3): small units, a time budget, and a
// discarded check deleted as soon as its file is gone (Mojtaba B2). The SQL is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');

/** A clock that moves on by `stepMs` at every reading, to run out a budget. */
class SteppingClock implements Clock {
  #now = T0;
  constructor(private readonly stepMs: number) {}
  now(): Temporal.Instant {
    const current = this.#now;
    this.#now = this.#now.add({ milliseconds: this.stepMs });
    return current;
  }
}

describe.each(['AU', 'ZZ'] as const)('catalog.purge-platform-imports in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  function rig(options: { due?: number; discarded?: number; settled?: number; stepMs?: number }) {
    let due = options.due ?? 0;
    let discarded = options.discarded ?? 0;
    let settled = options.settled ?? 0;
    const limits: number[] = [];
    const deletedKeys: string[] = [];
    const importJobs = {
      filesDue: (_m: MarketContext, _before: Temporal.Instant, limit: number) => {
        limits.push(limit);
        const take = Math.min(due, limit);
        return Promise.resolve(
          Array.from({ length: take }, (_, n) => ({
            id: `job-${due - n}` as Id<'PlatformImport'>,
            fileKey: `catalog/imports/${code}/${due - n}`,
          })),
        );
      },
      markFileDeleted: () => {
        due -= 1;
        discarded += 1;
        return Promise.resolve();
      },
      deleteDiscarded: (_m: MarketContext, scope: { limit: number }) => {
        limits.push(scope.limit);
        const take = Math.min(discarded, scope.limit);
        discarded -= take;
        return Promise.resolve(take);
      },
      deleteSettledBefore: (_m: MarketContext, _b: Temporal.Instant, limit: number) => {
        limits.push(limit);
        const take = Math.min(settled, limit);
        settled -= take;
        return Promise.resolve(take);
      },
    } as unknown as PlatformImportRepository;
    const importFiles: ImportFileStore = {
      keyOf: (_m, id) => `catalog/imports/${code}/${id}`,
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: (key) => {
        deletedKeys.push(key);
        return Promise.resolve();
      },
    };
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const useCase = new PlatformImportPurge(gate, {
      unitOfWork,
      importJobs,
      importFiles,
      clock: new SteppingClock(options.stepMs ?? 0),
    });
    return { useCase, limits, deletedKeys, left: () => ({ due, discarded, settled }) };
  }

  it('works in units of at most 5 jobs and loops until nothing is left', async () => {
    const r = rig({ due: 12, discarded: 3, settled: 11 });
    const outcome = await r.useCase.execute(testCallContext(market, 'system'), {});
    // 12 files go, the 12 checks they discard and the 3 already discarded: 15 jobs; plus 11 settled.
    expect(outcome).toEqual({ ok: true, value: { filesDeleted: 12, jobsDeleted: 15 + 11 } });
    expect(PURGE_BATCH).toBe(5);
    expect(Math.max(...r.limits)).toBe(5);
    expect(r.left()).toEqual({ due: 0, discarded: 0, settled: 0 });
  });

  it('stops within its time budget and leaves the rest to the next run', async () => {
    // Every clock reading costs a tenth of the budget: a few units fit, not all.
    const r = rig({ due: 200, stepMs: PURGE_BUDGET_MS / 10 });
    const outcome = await r.useCase.execute(testCallContext(market, 'system'), {});
    expect(outcome.ok).toBe(true);
    expect(r.left().due).toBeGreaterThan(0);
    expect(r.deletedKeys.length).toBeLessThan(200);
  });

  it('runs only as the system actor', async () => {
    const r = rig({ due: 1 });
    const outcome = await r.useCase.execute(testCallContext(market, 'anonymous'), {});
    expect(outcome).toMatchObject({ ok: false });
    expect(r.deletedKeys).toEqual([]);
  });
});
