import { err, ok } from '@mondapac/shared-kernel';
import type { JobContext } from '../../../../platform/scheduler/job-registry';
import { MIN_INTERVAL_MS, intervalMsOf } from '../../../../platform/scheduler/job-registry';
import type { PollFleetStatus } from '../../application/use-cases/poll-fleet-status.use-case';
import { POLL_FLEET_STATUS_JOB, pollFleetStatusJob } from './poll-fleet-status.job';

describe('shipping.poll-fleet-status job', () => {
  const context = { market: { marketId: 'AU' } } as JobContext;

  it('is named for shipping and runs every five minutes', () => {
    const job = pollFleetStatusJob({ execute: () => Promise.resolve(ok({})) } as never);
    expect(job.name).toBe(POLL_FLEET_STATUS_JOB);
    expect(job.name.startsWith('shipping.')).toBe(true);
    expect(intervalMsOf(job)).toBe(300_000);
    expect(intervalMsOf(job)).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
  });

  it('calls the system use case once with the job context', async () => {
    const calls: unknown[] = [];
    const poll = {
      execute: (c: unknown) => {
        calls.push(c);
        return Promise.resolve(ok({ fleets: 0, asked: 0, changed: 0, failed: 0 }));
      },
    } as unknown as PollFleetStatus;
    await pollFleetStatusJob(poll).run(context);
    expect(calls).toEqual([context]);
  });

  it('throws on a refusal, so the scheduler logs the Market run as failed', async () => {
    const poll = {
      execute: () => Promise.resolve(err({ code: 'shipping.carrier-unavailable' })),
    } as unknown as PollFleetStatus;
    await expect(pollFleetStatusJob(poll).run(context)).rejects.toThrow(
      'shipping.carrier-unavailable',
    );
  });
});
