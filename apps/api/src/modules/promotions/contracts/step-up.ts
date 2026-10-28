import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions promotions owns. One admin action: a platform admin presents a fresh
 * two-step code (`POST identity/admin/step-up/verify`) before committing platform money above the
 * Market's threshold (a new budget or a larger one; Market config
 * `promotions.platformBudgetStepUpMinor`), before flagging a special campaign (the commission cap
 * does not apply to it), and before raising the first-order monthly budget above the threshold.
 * The need depends on the amount, so no route is guarded by `@RequiresStepUp`: the use cases spend
 * the proof in their own unit (ADR-0018), as wallet's `setStatus` does.
 */
export const PROMOTIONS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  {
    key: 'promotions.platform-funding.approve',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];

export const PROMOTIONS_PLATFORM_FUNDING_STEP_UP = 'promotions.platform-funding.approve';
