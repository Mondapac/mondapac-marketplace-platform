import { Global, Module } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { CLOCK } from '../clock/clock.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { registerJobsFrom } from '../scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../unit-of-work/unit-of-work';
import {
  SECURITY_EVENT_STORE,
  SecurityEventRetention,
  securityEventsRetentionJob,
  type SecurityEventStore,
} from './security-event-retention';

/**
 * Security events (docs/design/data/platform.md 13): the retention of
 * `platform.security_events` and its archive, and its job `platform.security-events-retention`
 * (the worker runs it; both roles build it). The recorder is implemented by the persistence
 * module and bound per module with `PersistenceModule.securityEventsFor`; the store is bound
 * here only and not exported, so no module reads or deletes events.
 */
@Global()
@Module({
  providers: [
    PersistenceModule.securityEventStore(),
    {
      provide: SecurityEventRetention,
      inject: [UNIT_OF_WORK, SECURITY_EVENT_STORE, CLOCK],
      useFactory: (unitOfWork: UnitOfWork, store: SecurityEventStore, clock: Clock) =>
        new SecurityEventRetention(unitOfWork, store, clock),
    },
    registerJobsFrom('platform', [SecurityEventRetention], (retention: SecurityEventRetention) => [
      securityEventsRetentionJob(retention),
    ]),
  ],
})
export class SecurityEventsModule {}
