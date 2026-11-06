import type { StepUpActionDeclaration } from '../../../platform/authz';

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
];
