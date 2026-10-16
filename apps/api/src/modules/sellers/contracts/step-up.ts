import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions sellers owns (seller OTP policy): a seller's own rule decides whether each asks
 * for a fresh two-step code. Guarded on the seller route with `@RequiresStepUp`.
 */
export const SELLERS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'sellers.store-terms.change', defaultRequired: false, locked: false },
];
