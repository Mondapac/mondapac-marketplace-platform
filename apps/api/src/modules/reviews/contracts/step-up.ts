import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions reviews owns (buyer reviews and ratings package 2). All are admin actions: a
 * platform admin presents a fresh two-step code (`POST identity/admin/step-up/verify`) before the
 * action, which is spent in the use case's unit (ADR-0018).
 * - `reviews.settings.change`: moving the Market's reviews switch (`PUT /reviews/admin/settings`).
 * - `reviews.review.moderate`: publishing, hiding, restoring or removing a review.
 */
export const REVIEWS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'reviews.settings.change', defaultRequired: true, locked: true, audience: 'admin' },
  { key: 'reviews.review.moderate', defaultRequired: true, locked: true, audience: 'admin' },
];

export const REVIEWS_SETTINGS_CHANGE_STEP_UP = 'reviews.settings.change';
export const REVIEWS_MODERATE_STEP_UP = 'reviews.review.moderate';
