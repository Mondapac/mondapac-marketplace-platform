// What the worker's turn of an import does about the answers of the use cases a row calls, and the
// numbers of its claim (catalog design 14a, 14c). Shared by the admin and the seller import so the
// two never drift: how long a lease lasts, how long a throttled job waits, which answers wait and
// which stop the job.

/** How long a runner holds a job before another may take it over (it renews the lease per batch). */
export const LEASE_SECONDS = 120;
/** Rows read from the store at a time. */
export const BATCH = 20;
/** A wait of this length or shorter is a rate window of a minute: the job waits it out. */
export const MAX_WAIT_SECONDS = 120;
/** A transient fault is retried after this long. */
export const RETRY_SECONDS = 60;
/** A job that keeps meeting transient faults for this long stops instead (stop reason `unexpected`). */
export const GIVE_UP_AFTER_HOURS = 24;

/** The use-case failure codes a row may be reported with: codes only, never a message. */
export function reasonOf(code: string): string {
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(code) ? code : 'row.failed';
}

/** What the run does about a refusal of a use case a row called. */
export type FailureAction =
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'transient' }
  | { readonly kind: 'access-lost' };

/**
 * Maps a refusal to what the run does about it: a throttle waits out its window (the run decides
 * whether it is short enough), a refusal of the gate means the person lost the key or the account
 * (`access-lost`), a store that cannot answer, a lost race and a busy parser are transient, and
 * anything else fails that row with its code.
 */
export function failureActionOf(code: string, detail?: unknown): FailureAction {
  switch (code) {
    case 'request.throttled':
      return {
        kind: 'wait',
        seconds: Math.max(
          1,
          Number(
            (detail as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ??
              RETRY_SECONDS,
          ),
        ),
      };
    case 'access.denied':
      return { kind: 'access-lost' };
    case 'access.unavailable':
    case 'conflict.stale':
    case 'conflict.retry':
    case 'file.busy':
      return { kind: 'transient' };
    default:
      return { kind: 'failed', code };
  }
}
