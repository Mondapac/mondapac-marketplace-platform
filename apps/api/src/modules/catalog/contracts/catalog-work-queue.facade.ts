import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/** What the Offer queue backlog alert reads: how many Offers wait, and since when the oldest. */
export interface OfferReviewQueueSnapshot {
  readonly count: number;
  /** When the Offer that has waited longest was submitted; null when the queue is empty. */
  readonly oldestAt: Temporal.Instant | null;
}

export type OfferReviewQueueFailure = { readonly code: 'access.unavailable' };

/**
 * The catalog queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case), platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface CatalogWorkQueueFacade {
  /** Offer certification tags still active after their certificate expired (an incident). */
  claimsWithoutCertificate(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The Offers waiting for their first-publication review. */
  pendingOffers(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /**
   * The Offers waiting for their first-publication review as a count and the oldest submission,
   * for the queue backlog alert (risk-based Offer approval, slice 8). Rule `system`: the alert
   * runs as the Market's system actor, which the admin-only dashboard count refuses.
   */
  offerReviewQueue(
    context: CallContext,
    query: { readonly now: Temporal.Instant },
  ): Promise<Result<OfferReviewQueueSnapshot, AccessDenied | OfferReviewQueueFailure>>;

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
