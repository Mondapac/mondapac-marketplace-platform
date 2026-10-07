import { Module } from '@nestjs/common';
import { OUTBOX_RELAY, type OutboxRelay } from '../events/event-bus';
import { Scheduler } from '../scheduler/scheduler';
import { WorkerRuntime } from './worker-runtime';

/**
 * The worker runtime (platform persistence design, "P", 8). Part of the one module graph both
 * roles build; only the `worker` role's start function calls `WorkerRuntime.start()`.
 */
@Module({
  providers: [
    {
      provide: WorkerRuntime,
      inject: [OUTBOX_RELAY, Scheduler],
      useFactory: (relay: OutboxRelay, scheduler: Scheduler) => new WorkerRuntime(relay, scheduler),
    },
  ],
  exports: [WorkerRuntime],
})
export class WorkerModule {}
