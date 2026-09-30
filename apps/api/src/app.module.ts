import { Module, type DynamicModule } from '@nestjs/common';
import type { DestinationStream } from 'pino';
import { CORE_MODULES } from './modules';
import type { AppConfig } from './platform/config/app-config';
import { ConfigModule } from './platform/config/config.module';
import { HealthModule } from './platform/health/health.module';
import { LoggingModule } from './platform/logging/logging.module';
import { PersistenceModule } from './platform/persistence/persistence.module';

export interface AppModuleOptions {
  /** Overrides the configuration read from `process.env` (tests). */
  readonly config?: AppConfig;
  /** Overrides where log lines are written (tests). */
  readonly logDestination?: DestinationStream;
}

/**
 * Composition root of the modular monolith (ADR-0008). Registers the platform
 * runtime and every bounded-context module.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(options.config),
        LoggingModule.forRoot(options.logDestination),
        PersistenceModule,
        HealthModule,
        ...CORE_MODULES,
      ],
    };
  }
}
