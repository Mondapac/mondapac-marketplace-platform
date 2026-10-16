import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions payments owns (seller OTP policy): a seller's own rule decides whether each asks
 * for a fresh two-step code. The payout account always does: it is the platform floor, enforced in its own flow (a current code in the request).
 */
export const PAYMENTS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'payments.payout-account.change', defaultRequired: true, locked: true },
];
