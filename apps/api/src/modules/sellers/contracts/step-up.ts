import type { StepUpActionDeclaration } from '../../../platform/authz';

/** Switching a seller's Trusted-from-start flag (`PUT sellers/admin/:sellerId/offer-review/trusted`). */
export const SELLERS_OFFER_REVIEW_TRUST_STEP_UP = 'sellers.offer-review-trust.change';
/** Switching a seller's Offer review stop (`PUT sellers/admin/:sellerId/offer-review/stop`). */
export const SELLERS_OFFER_REVIEW_STOP_STEP_UP = 'sellers.offer-review-stop.change';

/**
 * The step-up actions sellers owns (seller OTP policy): a seller's own rule decides whether each asks
 * for a fresh two-step code. Guarded on the seller route with `@RequiresStepUp`.
 */
export const SELLERS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'sellers.store-terms.change', defaultRequired: false, locked: false },
  // Admin action (issue #491): replacing a seller's business activities asks the admin session for
  // a fresh two-step code on `PUT /sellers/admin/:sellerId/business-activities`.
  {
    key: 'sellers.business-activity.change',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  // Admin actions (risk-based Offer approval slice 4): a switch whose "off" lowers review for many
  // Offers. The guard checks the proof on the route; the change spends it in its own unit.
  {
    key: SELLERS_OFFER_REVIEW_TRUST_STEP_UP,
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: SELLERS_OFFER_REVIEW_STOP_STEP_UP,
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];
