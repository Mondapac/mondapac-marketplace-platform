import type { Temporal } from '@mondapac/shared-kernel';

/**
 * Every step-up action key of the platform, for the audit row's closed list (an audit field is an
 * enum, never free text). A module adds its key here when it registers the action; a contract
 * test checks the registry holds exactly these.
 */
export const STEP_UP_ACTION_KEYS = [
  'catalog.offer.delete',
  'customers.account-deletion-settings.change',
  'identity.second-factor.manage',
  'identity.team.change-role',
  'identity.team.invite-remove',
  'payments.payout-account.change',
  'pricing.price.change',
  'sellers.store-terms.change',
  'wallet.settings.change',
] as const;

/**
 * Whose panel an action belongs to (issue #491). A seller action follows the shop's rule and is
 * listed on the shop's policy screen; an admin action always asks a platform admin for a fresh
 * code (no per-shop rule) and is never listed to a shop. A declaration without one is a seller's.
 */
export type StepUpAudience = 'seller' | 'admin';

export function stepUpAudienceOf(action: { readonly audience?: StepUpAudience }): StepUpAudience {
  return action.audience === 'admin' ? 'admin' : 'seller';
}

/** A stored proof: a code was verified in this session for this one action at `verifiedAt`. */
export interface StepUpProof {
  readonly sessionId: string;
  readonly actionKey: string;
  readonly verifiedAt: Temporal.Instant;
}

/**
 * Whether a proof lets this session do this action now (issue #491): the same session, the same
 * action, fresh ({@link proofIsFresh}), and made with the current factor (a proof from before the
 * factor was activated does not count: removing or re-enrolling it ends every earlier proof).
 */
export function proofCovers(
  proof: StepUpProof | null,
  request: {
    readonly sessionId: string;
    readonly actionKey: string;
    readonly now: Temporal.Instant;
    readonly factorActivatedAt: Temporal.Instant | null;
    readonly minutes: number;
  },
): boolean {
  if (proof === null) return false;
  if (proof.sessionId !== request.sessionId || proof.actionKey !== request.actionKey) return false;
  if (
    request.factorActivatedAt !== null &&
    proof.verifiedAt.epochMilliseconds < request.factorActivatedAt.epochMilliseconds
  ) {
    return false;
  }
  return proofIsFresh(proof.verifiedAt, request.now, request.minutes);
}

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
