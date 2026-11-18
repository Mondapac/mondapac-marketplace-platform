import { err, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { Logger } from '@nestjs/common';
import type { JobContext } from '../../../../platform/scheduler/job-registry';
import type { SettleStaleRedemptions } from '../../application/use-cases/settle-stale-redemptions.use-case';
import {
  SETTLE_STALE_REDEMPTIONS_JOB,
  settleStaleRedemptionsJob,
} from './settle-stale-redemptions.job';

describe.each(['AU', 'ZZ'] as const)(
  'ordering.settle-stale-redemptions job in market %s',
  (code) => {
    const context = testCallContext(
      testMarketContext(code, 'default'),
      'system',
      'sweep-job-0001',
    ) as unknown as JobContext;
    const job = (answer: unknown) => {
      const calls: unknown[] = [];
      const useCase = {
        execute: (c: unknown, input: unknown) => {
          calls.push([c, input]);
          return Promise.resolve(answer);
        },
      } as unknown as SettleStaleRedemptions;
      return { definition: settleStaleRedemptionsJob(useCase), calls };
    };
    const counts = { confirmed: 0, released: 0, expired: 0, waiting: 0, failed: 0 };
    let log: jest.SpyInstance;
    let warn: jest.SpyInstance;
    beforeEach(() => {
      log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('runs every 15 minutes with the scheduler context unchanged and an empty input', async () => {
      const { definition, calls } = job(ok(counts));
      expect(definition.name).toBe(SETTLE_STALE_REDEMPTIONS_JOB);
      expect(definition.every.total('minutes')).toBe(15);
      await definition.run(context);
      expect(calls).toEqual([[context, {}]]);
    });

    it('logs nothing when there was nothing to do', async () => {
      await job(ok(counts)).definition.run(context);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs what it settled, and warns on a failure or an order still waiting', async () => {
      await job(ok({ ...counts, released: 2 })).definition.run(context);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ msg: SETTLE_STALE_REDEMPTIONS_JOB, released: 2, marketId: code }),
      );
      await job(ok({ ...counts, waiting: 1 })).definition.run(context);
      await job(ok({ ...counts, failed: 1 })).definition.run(context);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('throws when the use case refuses, so the scheduler records the failure', async () => {
      await expect(job(err({ code: 'access.denied' })).definition.run(context)).rejects.toThrow(
        `${SETTLE_STALE_REDEMPTIONS_JOB} refused`,
      );
    });
  },
);
