import type { Id, Temporal } from '@mondapac/shared-kernel';

/**
 * `pending` waits for its date and is the only state the buyer can cancel; `executing` is claimed
 * by the job (its first irreversible step is next or under way) and can no longer be cancelled;
 * `cancelled` and `completed` are final.
 */
export type AccountDeletionRequestStatus = 'pending' | 'executing' | 'cancelled' | 'completed';

/**
 * A claim older than this is taken to belong to a job run that died: the next run claims it again
 * and repeats the steps (each is safe to repeat). Far longer than one run's steps take.
 */
export const CLAIM_STALE_AFTER_MINUTES = 15;

/** One buyer deletion request (`customers.account_deletion_requests`): ids, a status and times. */
export interface AccountDeletionRequest {
  readonly id: Id<'AccountDeletionRequest'>;
  readonly accountId: Id<'Account'>;
  readonly status: AccountDeletionRequestStatus;
  /** The waiting period in force when the request was made; the request keeps it. */
  readonly waitingPeriodDays: number;
  readonly requestedAt: Temporal.Instant;
  readonly scheduledFor: Temporal.Instant;
  /** When the job claimed it (`executing`); null while pending, and for a request cancelled before. */
  readonly claimedAt: Temporal.Instant | null;
}

/**
 * When a request made at `requestedAt` is carried out: the waiting period later, as an instant of
 * the injected Clock (UTC; no calendar or zone arithmetic: a day is 24 hours here).
 */
export function scheduledForRequest(
  requestedAt: Temporal.Instant,
  waitingPeriodDays: number,
): Temporal.Instant {
  return requestedAt.add({ hours: waitingPeriodDays * 24 });
}

/** Why a request cannot be made now. Counts only: no order id, no amount. */
export type AccountDeletionBlocker =
  | { readonly code: 'open-orders'; readonly count: number }
  | { readonly code: 'pending-refunds'; readonly count: number }
  | { readonly code: 'wallet-balance' };
