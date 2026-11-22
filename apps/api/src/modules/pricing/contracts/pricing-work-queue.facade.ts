import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The pricing queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case), platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface PricingWorkQueueFacade {
  /** The held price changes. */
  priceHolds(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link PricingWorkQueueFacade}, provided and exported by `PricingModule`. */
export const PRICING_WORK_QUEUE_FACADE = Symbol('PRICING_WORK_QUEUE_FACADE');
