import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { REVIEWS_STATUSES } from './market-status';

// The audited action of reviews (the Market switch), registered at boot with
// `registerAuditActions('reviews', REVIEWS_AUDIT_ACTIONS)`. A review's text is never audited: it
// is personal content and has no field here.

/** The audit target type of the reviews switch. */
export const REVIEWS_SETTINGS_TARGET = 'reviews.market-settings';

/** An admin moved the Market's reviews to another state. */
export const ReviewsStatusChanged = defineAuditAction({
  action: 'reviews.market-status.changed',
  targetType: REVIEWS_SETTINGS_TARGET,
  targetId: auditField.enumOf(['reviews-settings'] as const),
  actors: ['authenticated'],
  before: { status: auditField.enumOf(REVIEWS_STATUSES) },
  after: { status: auditField.enumOf(REVIEWS_STATUSES) },
});

export const REVIEWS_AUDIT_ACTIONS = [ReviewsStatusChanged] as const;
