import { err, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { JobContext } from '../../../../platform/scheduler/job-registry';
import { MAX_RUN_MS } from '../../../../platform/scheduler/job-registry';
import type { RebuildOfferPairs } from '../../application/use-cases/rebuild-offer-pairs.use-case';
import { REBUILD_OFFER_PAIRS_JOB, rebuildOfferPairsJob } from './rebuild-offer-pairs.job';

describe.each(['AU', 'ZZ'] as const)('ordering.rebuild-offer-pairs job in market %s', (code) => {
  const context = testCallContext(
    testMarketContext(code, 'default'),
    'system',
    'pairs-job-0001',
  ) as unknown as JobContext;
  const rebuild = (answer: unknown) => {
    const calls: unknown[] = [];
    const useCase = {
      execute: (c: unknown) => {
        calls.push(c);
        return Promise.resolve(answer);
      },
    } as unknown as RebuildOfferPairs;
    return { job: rebuildOfferPairsJob(useCase), calls };
  };

  it('is registered daily under its name, with the longest lock, and runs the use case with the Market context', async () => {
    const { job, calls } = rebuild(ok({ rows: 4, skippedLargeOrders: 0 }));

    expect(job.name).toBe(REBUILD_OFFER_PAIRS_JOB);
    expect(job.name).toBe('ordering.rebuild-offer-pairs');
    expect(job.every.total({ unit: 'hours' })).toBe(24);
    expect(job.maxRunMs).toBe(MAX_RUN_MS);
    await expect(job.run(context)).resolves.toBeUndefined();
    expect(calls).toEqual([context]);
  });

  it.each(['access.denied', 'ordering.offer-pairs-too-many'])(
    'throws on the refusal %s',
    async (reason) => {
      const { job } = rebuild(err({ code: reason }));

      await expect(job.run(context)).rejects.toThrow(reason);
    },
  );
});
