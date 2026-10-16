import type { Temporal } from '@mondapac/shared-kernel';

/**
 * Every step-up action key of the platform, for the audit row's closed list (an audit field is an
 * enum, never free text). A module adds its key here when it registers the action; a contract
 * test checks the registry holds exactly these.
 */
export const STEP_UP_ACTION_KEYS = [
  'catalog.offer.delete',
  'identity.second-factor.manage',
  'identity.team.change-role',
  'identity.team.invite-remove',
  'payments.payout-account.change',
  'pricing.price.change',
  'sellers.store-terms.change',
] as const;

/**
 * Whether an action asks for a fresh code (seller OTP policy). A locked action always does (the
 * platform floor); otherwise the seller's own rule decides, and a missing rule means the default.
 */
export function stepUpRequired(
  action: { readonly defaultRequired: boolean; readonly locked: boolean },
  sellerRule: boolean | undefined,
): boolean {
  if (action.locked) return true;
  return sellerRule ?? action.defaultRequired;
}

/** Whether a code verified at `verifiedAt` still covers its action at `now`. */
export function proofIsFresh(
  verifiedAt: Temporal.Instant,
  now: Temporal.Instant,
  minutes: number,
): boolean {
  const age = now.epochMilliseconds - verifiedAt.epochMilliseconds;
  return age >= 0 && age < minutes * 60_000;
}
