import type { StepUpActionDeclaration } from '../../../platform/authz';

/** Switching a category's "always review" flag (`PUT catalog/admin/categories/:id/offer-review`). */
export const CATALOG_CATEGORY_REVIEW_STEP_UP = 'catalog.category-review.change';
/** Switching a category's Offer review stop (`PUT catalog/admin/categories/:id/offer-review-stop`). */
export const CATALOG_OFFER_REVIEW_STOP_STEP_UP = 'catalog.offer-review-stop.change';

/**
 * The step-up actions catalog owns (seller OTP policy): a seller's own rule decides whether each asks
 * for a fresh two-step code. Guarded on the seller route with `@RequiresStepUp`.
 */
export const CATALOG_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'catalog.offer.delete', defaultRequired: false, locked: false },
  // Admin actions (risk-based Offer approval slice 4): the category flags, whose "off" lowers
  // review for many Offers. The guard checks the proof on the route; the change spends it.
  {
    key: CATALOG_CATEGORY_REVIEW_STEP_UP,
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: CATALOG_OFFER_REVIEW_STOP_STEP_UP,
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];
