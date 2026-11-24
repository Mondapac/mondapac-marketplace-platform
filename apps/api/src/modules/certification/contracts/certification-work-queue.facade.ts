import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/** What the dashboard asks the expiring-certificates count for (one Clock read for the answer). */
export interface ExpiringCertificatesQuery {
  readonly now: Temporal.Instant;
  /** Aborts when the dashboard stops waiting; the count answers `access.unavailable`. */
  readonly signal: AbortSignal;
}

/** Approved seller certificates whose validity ends within the next `withinDays` Market days. */
export interface ExpiringCertificates {
  readonly count: number;
  readonly withinDays: number;
  /** The end (exclusive) of the window: the start of the Market day after the last one. */
  readonly until: Temporal.Instant;
}

/**
 * The certification queues of the admin dashboard's work queue (dashboards upgrade, phase 1). Each method
 * runs one use case with the caller's `CallContext` unchanged (the key of each is on its use
 * case), platform admins only. Not exposed over HTTP; the dashboard module composes them.
 */
export interface CertificationWorkQueueFacade {
  /** The sellers' certificate submissions waiting for review. */
  sellerCertificates(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /** The product certificate revisions waiting for review. */
  productCertificates(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;

  /**
   * The approved seller certificates expiring within the next 30 Market days (dashboards v2: the
   * supply and health card). A count only. Key `certification.seller-certificate.view`.
   */
  expiringCertificates(
    context: CallContext,
    query: ExpiringCertificatesQuery,
  ): Promise<Result<ExpiringCertificates, AccessDenied>>;
}

/** Nest token of the {@link CertificationWorkQueueFacade}, provided and exported by `CertificationModule`. */
export const CERTIFICATION_WORK_QUEUE_FACADE = Symbol('CERTIFICATION_WORK_QUEUE_FACADE');
