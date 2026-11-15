import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { POLICY_AREAS, REVIEW_AREAS, RISKS } from './areas';

// The audited actions of system-requests, registered at boot with
// `registerAuditActions('system-requests', SYSTEM_REQUESTS_AUDIT_ACTIONS)`. Ids, enums, counts and
// instants only: the note, the reason, a comment and the values of the change stay in the
// module's own tables (the request and its activity), never in the audit log.

/** The audit target type of a review request. */
export const REQUEST_TARGET = 'system-requests.request';
/** The audit target type of the review policy; the target id is the area or review-due-days. */
export const POLICY_TARGET = 'system-requests.policy';

const POLICY_TARGET_IDS = [...POLICY_AREAS, 'review-due-days'] as const;

/** A change went live in a reviewed area and its review request was opened. */
export const RequestOpened = defineAuditAction({
  action: 'system-requests.request.opened',
  targetType: REQUEST_TARGET,
  actors: ['authenticated'],
  after: {
    number: auditField.integer(),
    area: auditField.enumOf(REVIEW_AREAS),
    risk: auditField.enumOf(RISKS),
    reviewDueAt: auditField.instant(),
    /** At most one in practice: every opening supersedes all earlier requests of the subject. */
    supersedes: auditField.listOf(auditField.id(), 10),
  },
});

/** A second admin approved the change; it stays live. */
export const RequestApproved = defineAuditAction({
  action: 'system-requests.request.approved',
  targetType: REQUEST_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['open'] as const) },
  after: {
    status: auditField.enumOf(['approved'] as const),
    requestedBy: auditField.id(),
    risk: auditField.enumOf(RISKS),
    stepUpSessionId: auditField.optional(auditField.id()),
    stepUpVerifiedAt: auditField.optional(auditField.instant()),
  },
});

/** A reviewer rejected the change, or its author withdrew it: the value before was restored. */
export const RequestReverted = defineAuditAction({
  action: 'system-requests.request.reverted',
  targetType: REQUEST_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['open'] as const) },
  after: {
    status: auditField.enumOf(['reverted'] as const),
    decision: auditField.enumOf(['rejected', 'withdrawn'] as const),
    requestedBy: auditField.id(),
    risk: auditField.enumOf(RISKS),
    stepUpSessionId: auditField.optional(auditField.id()),
    stepUpVerifiedAt: auditField.optional(auditField.instant()),
  },
});

/** Someone commented on a request (the text stays in the request's activity). */
export const RequestCommented = defineAuditAction({
  action: 'system-requests.request.commented',
  targetType: REQUEST_TARGET,
  actors: ['authenticated'],
  after: { commentCount: auditField.integer() },
});

/** An admin changed the review policy of an area, or the review period. */
export const PolicyChanged = defineAuditAction({
  action: 'system-requests.policy.changed',
  targetType: POLICY_TARGET,
  targetId: auditField.enumOf(POLICY_TARGET_IDS),
  actors: ['authenticated'],
  before: {
    enabled: auditField.optional(auditField.boolean()),
    risk: auditField.optional(auditField.enumOf(RISKS)),
    reviewDueDays: auditField.optional(auditField.integer()),
  },
  after: {
    enabled: auditField.optional(auditField.boolean()),
    risk: auditField.optional(auditField.enumOf(RISKS)),
    reviewDueDays: auditField.optional(auditField.integer()),
    version: auditField.integer(),
    /** The review request the change opened; absent when a revert restored the value. */
    requestId: auditField.optional(auditField.id()),
  },
});

export const SYSTEM_REQUESTS_AUDIT_ACTIONS = [
  RequestOpened,
  RequestApproved,
  RequestReverted,
  RequestCommented,
  PolicyChanged,
] as const;
