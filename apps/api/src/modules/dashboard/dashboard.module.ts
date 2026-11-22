import { Module } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import { VIEWER_PERMISSIONS, type ViewerPermissions } from './application/ports/viewer-permissions';
import { ViewAdminWorkQueue } from './application/use-cases/view-admin-work-queue.use-case';
import { WorkQueueCache } from './application/work-queue-cache';
import { WORK_QUEUE_TIMEOUT_MS } from './application/work-queue-flow';
import {
  checkWorkQueueSources,
  WORK_QUEUE_SOURCES,
  type WorkQueueSource,
} from './application/work-queue-source';
import { IdentityViewerPermissions } from './infrastructure/identity-viewer-permissions';
import { AdminDashboardController } from './presentation/admin-dashboard.controller';

/**
 * The work-queue sources of both panels, each bound to its owner's public facade. Phase 1 adds
 * them module by module (ordering, catalog and sellers, security and certification, payments and
 * commission-payouts); until then the list is empty and the work queue answers no queues.
 */
export function workQueueSources(): readonly WorkQueueSource[] {
  return [];
}

/**
 * Dashboard (dashboards upgrade, option B; design section 6): a composition module with no tables
 * of its own. It reads only through other modules' public facades, with the caller's context
 * unchanged, and no module imports it (dependency-cruiser `nothing-imports-dashboard`).
 */
@Module({
  imports: [IdentityModule],
  controllers: [AdminDashboardController],
  providers: [
    {
      provide: VIEWER_PERMISSIONS,
      inject: [IDENTITY_FACADE],
      useFactory: (identity: IdentityFacade) => new IdentityViewerPermissions(identity),
    },
    {
      provide: WORK_QUEUE_SOURCES,
      useFactory: () => {
        const sources = workQueueSources();
        checkWorkQueueSources(sources);
        return sources;
      },
    },
    { provide: WorkQueueCache, useFactory: () => new WorkQueueCache() },
    {
      provide: ViewAdminWorkQueue,
      inject: [USE_CASE_GATE, VIEWER_PERMISSIONS, WORK_QUEUE_SOURCES, WorkQueueCache, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        viewer: ViewerPermissions,
        sources: readonly WorkQueueSource[],
        cache: WorkQueueCache,
        clock: Clock,
      ) =>
        new ViewAdminWorkQueue(gate, {
          viewer,
          sources,
          cache,
          clock,
          timeoutMs: WORK_QUEUE_TIMEOUT_MS,
        }),
    },
  ],
})
export class DashboardModule {}
