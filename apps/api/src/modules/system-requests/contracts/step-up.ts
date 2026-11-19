import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions system-requests owns. Both are admin actions with a locked rule.
 *
 * `system-requests.request.decide-high`: approving, rejecting or withdrawing a high-risk request
 * (owner decision 15 Nov 2026: one approver from another admin, plus the second factor for high
 * risk). The risk is known only once the request is read, so no route carries `@RequiresStepUp`:
 * the use case spends the proof in the unit that decides, and answers `second-factor.required`
 * when there is none.
 *
 * `system-requests.policy.change`: changing the review policy (guarded on its routes with
 * `@RequiresStepUp` and spent in the unit that changes it), so nobody turns review off quietly.
 */
export const SYSTEM_REQUESTS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  {
    key: 'system-requests.policy.change',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: 'system-requests.request.decide-high',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];

export const SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP = 'system-requests.request.decide-high';
export const SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP = 'system-requests.policy.change';
