import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions pricing owns (seller OTP policy): a seller's own rule decides whether each asks
 * for a fresh two-step code. Guarded on the seller route with `@RequiresStepUp`.
 */
export const PRICING_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'pricing.price.change', defaultRequired: false, locked: false },
];
