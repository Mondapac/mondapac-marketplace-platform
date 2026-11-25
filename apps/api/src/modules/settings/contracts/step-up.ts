import type { StepUpActionDeclaration } from '../../../platform/authz';

/** Switching the Offer review emergency stop (R0) on or off (`PUT settings/admin/offer-review/emergency-stop`). */
export const SETTINGS_EMERGENCY_STOP_STEP_UP = 'settings.offer-review-emergency-stop.change';
/** Changing the Offer review policy page (`PUT settings/admin/offer-review`). */
export const SETTINGS_OFFER_REVIEW_STEP_UP = 'settings.offer-review.change';

/**
 * The step-up actions settings owns (Hassan, PR 2b). Both are admin actions: a platform admin
 * presents a fresh two-step code (`POST identity/admin/step-up/verify`) before the change, and the
 * proof is spent in the change's own unit (ADR-0018). One change can send every new Offer of the
 * Market past the admin, or stop them all.
 */
export const SETTINGS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: SETTINGS_EMERGENCY_STOP_STEP_UP, defaultRequired: true, locked: true, audience: 'admin' },
  { key: SETTINGS_OFFER_REVIEW_STEP_UP, defaultRequired: true, locked: true, audience: 'admin' },
];
