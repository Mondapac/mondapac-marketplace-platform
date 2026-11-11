import { Global, Module } from '@nestjs/common';
import type { IdGenerator } from '@mondapac/shared-kernel';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketRegistry } from '../market-config/market-registry';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { JOB_LOCK, type JobLock } from './job-lock';
import { JobRegistry } from './job-registry';
import { maxConcurrentJobRunsOf, Scheduler } from './scheduler';

/**
 * The scheduler (platform persistence design, "P", 7): the job registry modules register
 * with, and the runner the worker starts. The lock is bound by the persistence module.
 */
@Global()
@Module({
  providers: [
    JobRegistry,
    {
      provide: Scheduler,
      inject: [
        JobRegistry,
        JOB_LOCK,
        MarketRegistry,
        MarketContextFactory,
        ID_GENERATOR,
        APP_CONFIG,
      ],
      useFactory: (
        registry: JobRegistry,
        lock: JobLock,
        markets: MarketRegistry,
        contexts: MarketContextFactory,
        ids: IdGenerator,
        config: AppConfig,
      ) =>
        new Scheduler(
          registry,
          lock,
          markets,
          contexts,
          ids,
          Math.random,
          maxConcurrentJobRunsOf(config.databasePoolMax),
        ),
    },
  ],
  exports: [JobRegistry, Scheduler],
})
export class SchedulerModule {}
