import type { AccessDenied, StepUpActionDeclaration } from '../../../platform/authz';

/** How long a fresh code covers its one action (seller OTP policy). */
export const STEP_UP_PROOF_MINUTES = 5;

/**
 * The step-up actions identity owns (seller OTP policy proposal, 2026-10-16). Other modules
 * declare their own the same way and register them in their module file. `locked` rows are the
 * platform floor: a seller cannot turn them off.
 *
 * Enforcement: `identity.team.*` keys by `@RequiresStepUp` on the seller team routes;
 * `identity.second-factor.manage` inside the second-factor remove and recovery-codes use cases,
 * which already spend a code in the request itself.
 */
export const IDENTITY_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'identity.second-factor.manage', defaultRequired: true, locked: true },
  { key: 'identity.team.change-role', defaultRequired: true, locked: true },
  { key: 'identity.team.invite-remove', defaultRequired: true, locked: false },
];

/** Why {@link IdentityFacade.requireStepUp} did not let the action through. */
export type StepUpFailure =
  /** The action needs a fresh code: verify one for this action, then repeat the request. */
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  /** The action needs a code but the member has no two-step set up yet: set it up first. */
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | AccessDenied
  | { readonly code: 'access.unavailable' };
