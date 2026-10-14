import { err, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { JobContext } from '../../../../platform/scheduler/job-registry';
import type { PurgeInactiveCarts } from '../../application/use-cases/purge-inactive-carts.use-case';
import { PURGE_INACTIVE_CARTS_JOB, purgeInactiveCartsJob } from './purge-inactive-carts.job';

describe.each(['AU', 'ZZ'] as const)('cart.purge-inactive job in market %s', (code) => {
  const context = testCallContext(
    testMarketContext(code, 'default'),
    'system',
    'cart-job-0001',
  ) as unknown as JobContext;
  const purge = (answer: unknown) => {
    const calls: unknown[] = [];
    const useCase = {
      execute: (c: unknown) => {
        calls.push(c);
        return Promise.resolve(answer);
      },
    } as unknown as PurgeInactiveCarts;
    return { job: purgeInactiveCartsJob(useCase), calls };
  };

  it('is registered hourly under its name and runs the use case with the Market context', async () => {
    const { job, calls } = purge(ok({ carts: 1, rateCounters: 2 }));

    expect(job.name).toBe(PURGE_INACTIVE_CARTS_JOB);
    expect(job.name).toBe('cart.purge-inactive');
    expect(job.every.total({ unit: 'hours' })).toBe(1);
    await expect(job.run(context)).resolves.toBeUndefined();
    expect(calls).toEqual([context]);
  });

  it.each(['access.denied', 'cart.purge-failed'])('throws on the refusal %s', async (reason) => {
    const { job } = purge(err({ code: reason }));

    await expect(job.run(context)).rejects.toThrow(reason);
  });
});
