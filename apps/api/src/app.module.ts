import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { DestinationStream } from 'pino';
import { CORE_MODULES } from './modules';
import { AuthzModule } from './platform/authz/authz.module';
import { ClockModule } from './platform/clock/clock.module';
import type { AppConfig } from './platform/config/app-config';
import { ConfigModule } from './platform/config/config.module';
import { EventsModule } from './platform/events/events.module';
import { HealthModule } from './platform/health/health.module';
import { ConflictFilter } from './platform/http/conflict-filter';
import { IdsModule } from './platform/ids/ids.module';
import { LoggingModule } from './platform/logging/logging.module';
import { MarketConfigModule } from './platform/market-config/market-config.module';
import { MarketContextGuard } from './platform/market-context/market-context.guard';
import { MarketContextModule } from './platform/market-context/market-context.module';
import { PersistenceModule } from './platform/persistence/persistence.module';
import { SchedulerModule } from './platform/scheduler/scheduler.module';
import { SubjectKeysModule } from './platform/subject-keys/subject-keys.module';
import { WorkerModule } from './platform/worker/worker.module';

/**
 * Every global guard of the application, in the order they run (platform-foundations 5.1).
 * MarketContextGuard is first, so a request without a valid Market reaches nothing else.
 * No other module declares APP_GUARD, and `main.ts` adds no `useGlobalGuards`; a test
 * asserts this list and its order.
 */
export const GLOBAL_GUARDS = [MarketContextGuard] as const;

export interface AppModuleOptions {
  /** Overrides the configuration read from `process.env` (tests). */
  readonly config?: AppConfig;
  /** Overrides where log lines are written (tests). */
  readonly logDestination?: DestinationStream;
}

/**
 * Composition root of the modular monolith (ADR-0008). Registers the platform
 * runtime and every bounded-context module. Both process roles build this same graph
 * (platform persistence design 8): the same guards, event catalogue and job registry.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(options.config),
        LoggingModule.forRoot(options.logDestination),
        ClockModule,
        IdsModule,
        MarketConfigModule,
        MarketContextModule,
        AuthzModule,
        PersistenceModule,
        SubjectKeysModule,
        EventsModule,
        SchedulerModule,
        WorkerModule,
        HealthModule,
        ...CORE_MODULES,
      ],
      providers: [
        ...GLOBAL_GUARDS.map((guard) => ({ provide: APP_GUARD, useClass: guard })),
        // 409 for TransactionConflictError and StaleAggregateError (platform persistence 10).
        { provide: APP_FILTER, useClass: ConflictFilter },
      ],
    };
  }
}
