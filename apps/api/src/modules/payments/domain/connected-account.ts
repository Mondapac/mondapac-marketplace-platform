import type { Temporal } from '@mondapac/shared-kernel';
import { isCoolingOff } from './payout-change';

/** The states of a seller's connected account (payments design 3.4, simplified). */
export const ACCOUNT_STATUSES = [
  'not-started',
  'pending',
  'enabled',
  'restricted',
  'rejected',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** What Stripe reports about one connected account, narrowed to what payments keeps. */
export interface AccountSnapshot {
  readonly id: string;
  readonly metadataMarketId: string | null;
  readonly metadataSellerId: string | null;
  readonly detailsSubmitted: boolean;
  /** The `transfers` capability is `active`. */
  readonly transfersActive: boolean;
  readonly payoutsEnabled: boolean;
  /** How many requirements are listed as currently due (a count, never their content). */
  readonly requirementsDue: number;
  readonly requirementsPastDue: boolean;
  /** Stripe's `requirements.disabled_reason`, or null while the account is not disabled. */
  readonly disabledReason: string | null;
  /** Stripe's `settings.payouts.schedule.interval` (`manual`, `daily`, ...), or null when absent. */
  readonly payoutScheduleInterval: string | null;
}

/**
 * The status that follows a read from Stripe. `enabled` needs the transfers capability active,
 * payouts enabled, nothing past due and no disabled reason (an account under review is never
 * ready); an account that was `enabled` and no longer qualifies is
 * `restricted`; Stripe's own rejection is final. Before the seller has submitted the details the
 * account is `not-started`, afterwards `pending` until Stripe is satisfied.
 */
export function statusOf(snapshot: AccountSnapshot, previous: AccountStatus): AccountStatus {
  if (snapshot.disabledReason !== null && snapshot.disabledReason.startsWith('rejected')) {
    return 'rejected';
  }
  if (previous === 'rejected') return 'rejected';
  if (
    snapshot.transfersActive &&
    snapshot.payoutsEnabled &&
    !snapshot.requirementsPastDue &&
    snapshot.disabledReason === null
  ) {
    return 'enabled';
  }
  if (previous === 'enabled' || previous === 'restricted') return 'restricted';
  return snapshot.detailsSubmitted ? 'pending' : 'not-started';
}

/** Stripe can pay this seller: status `enabled`. */
export const isReady = (status: AccountStatus): boolean => status === 'enabled';

/** `ready` as payouts and the panel use it: enabled and not in the waiting period after a bank change. */
export const isPayoutReady = (
  status: AccountStatus,
  coolingOffUntil: Temporal.Instant | null,
  now: Temporal.Instant,
): boolean => isReady(status) && !isCoolingOff(coolingOffUntil, now);
