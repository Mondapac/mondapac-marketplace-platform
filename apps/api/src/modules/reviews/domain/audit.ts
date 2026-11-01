import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { REVIEWS_STATUSES } from './market-status';
import { MODERATOR_ACTIONS, REASONS_BY_ACTION } from './moderation';
import { REVIEW_STATUSES } from './rules';

// The audited action of reviews (the Market switch), registered at boot with
// `registerAuditActions('reviews', REVIEWS_AUDIT_ACTIONS)`. A review's text is never audited: it
// is personal content and has no field here.

/** The audit target type of the reviews switch. */
export const REVIEWS_SETTINGS_TARGET = 'reviews.market-settings';

/**
 * An admin moved the Market's reviews to another state. `after` names the admin step-up proof the
 * change spent: the session that verified the code and when.
 */
export const ReviewsStatusChanged = defineAuditAction({
  action: 'reviews.market-status.changed',
  targetType: REVIEWS_SETTINGS_TARGET,
  targetId: auditField.enumOf(['reviews-settings'] as const),
  actors: ['authenticated'],
  before: { status: auditField.enumOf(REVIEWS_STATUSES) },
  after: {
    status: auditField.enumOf(REVIEWS_STATUSES),
    stepUpSessionId: auditField.id(),
    stepUpVerifiedAt: auditField.instant(),
  },
});

/** The audit target type of a moderated review; the target id is the review's id. */
export const REVIEW_TARGET = 'reviews.product-review';

const REASON_CODES = [...new Set(Object.values(REASONS_BY_ACTION).flat())] as [string, ...string[]];

/**
 * A moderator published, hid, restored or removed a review, or dismissed its reports. Codes only:
 * the review's text, title and author are never audited. `after` names the step-up proof the
 * change spent (publish, hide, restore and remove; a dismissal spends none).
 */
export const ReviewModerated = defineAuditAction({
  action: 'reviews.review.moderated',
  targetType: REVIEW_TARGET,
  targetId: auditField.id(),
  actors: ['authenticated'],
  before: { status: auditField.enumOf(REVIEW_STATUSES) },
  after: {
    status: auditField.enumOf(REVIEW_STATUSES),
    action: auditField.enumOf(MODERATOR_ACTIONS),
    reasonCode: auditField.enumOf(REASON_CODES),
    stepUpSessionId: auditField.optional(auditField.id()),
    stepUpVerifiedAt: auditField.optional(auditField.instant()),
  },
});

export const REVIEWS_AUDIT_ACTIONS = [ReviewsStatusChanged, ReviewModerated] as const;
