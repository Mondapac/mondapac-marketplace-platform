import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The catalog queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case), platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface CatalogWorkQueueFacade {
  /** The Offers waiting for their first-publication review. */
  pendingOffers(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The sellers' product revisions waiting for review. */
  pendingRevisions(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The open brand merge groups. */
  brandMerges(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The sellers' category proposals waiting for a decision. */
  categoryProposals(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link CatalogWorkQueueFacade}, provided and exported by `CatalogModule`. */
export const CATALOG_WORK_QUEUE_FACADE = Symbol('CATALOG_WORK_QUEUE_FACADE');
