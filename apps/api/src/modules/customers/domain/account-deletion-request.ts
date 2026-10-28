import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';
import { parseChangeReason, type FieldError } from './account-deletion-settings';

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
  /** Who asked: the buyer, or an admin on the buyer's behalf (package 5c). */
  readonly requestedBy: AccountDeletionRequester;
  /** The admin's side of an admin request; null for the buyer's own. */
  readonly adminOrigin: AdminDeletionOrigin | null;
}

export type AccountDeletionRequester = 'customer' | 'admin';

/**
 * What an admin entered when asking for a buyer's deletion. Free text: kept on the request row
 * (part of the audit evidence) while the request is open and its reason redacted when it closes;
 * never in an event or an audit row.
 */
export interface AdminDeletionOrigin {
  readonly adminAccountId: Id<'Account'>;
  readonly ticketRef: string;
  /** Free text, possible personal data: null once the request is closed (redacted, ticket kept). */
  readonly reason: string | null;
}

/** A support ticket reference: 1 to 64 characters, letters, digits and `. _ # / -`, no spaces. */
export const TICKET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#/-]{0,63}$/;

export function parseTicketRef(value: unknown): Result<string, FieldError> {
  if (typeof value !== 'string') return err({ path: 'ticketRef', code: 'type' });
  const text = value.trim();
  if (text.length === 0) return err({ path: 'ticketRef', code: 'range' });
  if (!TICKET_REF_PATTERN.test(text)) return err({ path: 'ticketRef', code: 'format' });
  return ok(text);
}

/** The admin's reason (request or cancel): 1 to 500 characters of one line of plain text. */
export const parseAdminReason = parseChangeReason;

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
