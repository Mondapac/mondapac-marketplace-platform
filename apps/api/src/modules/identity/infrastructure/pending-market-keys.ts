import type { InvitationKind } from '../domain/invitation';
import type { ChallengePolicy } from '../domain/sign-in-challenge';
import type { ThrottleRule } from '../domain/throttle';

/**
 * The bounds each key must keep (identity design 6.1, 6.6, 6.8; HF2, HF6, HF15). They are the
 * guards the Market-config validator gets in the Market-config PR (the list of the slice 7b
 * report); until then this reader enforces them itself, so a value outside them is "not
 * configured", never a weaker rule.
 */
export const PENDING_KEY_BOUNDS = Object.freeze({
  /** `identity.invitations.lifetimeMinutes.<kind>`: admin at most 72 hours (HF15), others 7 days. */
  invitationLifetimeMinutes: Object.freeze({
    admin: { min: 1, max: 72 * 60 },
    'seller-owner': { min: 1, max: 7 * 24 * 60 },
    staff: { min: 1, max: 7 * 24 * 60 },
  } satisfies Record<InvitationKind, { min: number; max: number }>),
  /** `identity.challenges`: at most 5 attempts and 5 minutes (identity design 2.1, 6.8). */
  challengeMaxAttempts: { min: 1, max: 5 },
  challengeLifetimeSeconds: { min: 30, max: 300 },
  /**
   * `identity.secondFactorThrottles.account` (HF2): at most 10 failures in a window of at least
   * 24 hours, and a block of at least 24 hours (never 0: the block is the lock). Upper bound 7
   * days on both, as for the other counters' sanity.
   */
  secondFactorLimit: { min: 1, max: 10 },
  secondFactorWindowMinutes: { min: 24 * 60, max: 7 * 24 * 60 },
  secondFactorBlockMinutes: { min: 24 * 60, max: 7 * 24 * 60 },
});

type Bounds = { readonly min: number; readonly max: number };

const objectAt = (value: unknown, key: string): Readonly<Record<string, unknown>> | null => {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'object' && found !== null && !Array.isArray(found)
    ? (found as Readonly<Record<string, unknown>>)
    : null;
};

const wholeAt = (
  value: Readonly<Record<string, unknown>> | null,
  key: string,
  bounds: Bounds,
): number | null => {
  if (value === null || !Object.hasOwn(value, key)) return null;
  const found = value[key];
  return typeof found === 'number' &&
    Number.isInteger(found) &&
    found >= bounds.min &&
    found <= bounds.max
    ? found
    : null;
};

/**
 * Reads the slice 7b keys of a Market's `identity` section (identity design 6.7, the 7a note
 * "Needed for 7b"). The validated Market schema does not hold them yet: another track owns the
 * Market configuration and its validator, and adds them in their own PR. Until then every read
 * answers null, so admin sign-in, the invitation mail and the enrolment flows fail closed.
 *
 * The reader takes the section as `unknown` and checks shape and bounds itself
 * ({@link PENDING_KEY_BOUNDS}): a missing, malformed or out-of-bounds value is null, never a
 * default and never another Market's value. When the schema gains the keys under these names,
 * this reader needs no change.
 *
 * - `identity.invitations.lifetimeMinutes.{admin,seller-owner,staff}`
 * - `identity.challenges.{maxAttempts,lifetimeSeconds}`
 * - `identity.secondFactorThrottles.account.{limit,windowMinutes,blockMinutes}`
 */
export function pendingKeys(identity: unknown): {
  invitationLifetimeMinutes(kind: InvitationKind): number | null;
  challengePolicy(): ChallengePolicy | null;
  secondFactorThrottle(): ThrottleRule | null;
} {
  return {
    invitationLifetimeMinutes(kind) {
      const lifetimes = objectAt(objectAt(identity, 'invitations'), 'lifetimeMinutes');
      return wholeAt(lifetimes, kind, PENDING_KEY_BOUNDS.invitationLifetimeMinutes[kind]);
    },
    challengePolicy() {
      const challenges = objectAt(identity, 'challenges');
      const maxAttempts = wholeAt(
        challenges,
        'maxAttempts',
        PENDING_KEY_BOUNDS.challengeMaxAttempts,
      );
      const lifetimeSeconds = wholeAt(
        challenges,
        'lifetimeSeconds',
        PENDING_KEY_BOUNDS.challengeLifetimeSeconds,
      );
      return maxAttempts === null || lifetimeSeconds === null
        ? null
        : Object.freeze({ maxAttempts, lifetimeSeconds });
    },
    secondFactorThrottle() {
      const account = objectAt(objectAt(identity, 'secondFactorThrottles'), 'account');
      const limit = wholeAt(account, 'limit', PENDING_KEY_BOUNDS.secondFactorLimit);
      const windowMinutes = wholeAt(
        account,
        'windowMinutes',
        PENDING_KEY_BOUNDS.secondFactorWindowMinutes,
      );
      const blockMinutes = wholeAt(
        account,
        'blockMinutes',
        PENDING_KEY_BOUNDS.secondFactorBlockMinutes,
      );
      return limit === null || windowMinutes === null || blockMinutes === null
        ? null
        : Object.freeze({ limit, windowMinutes, blockMinutes });
    },
  };
}
