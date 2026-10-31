import type { ApiFailure } from '../api/client.ts';
import type { Blocker } from './types.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'customers.conflict': 'conflict',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
  'customers.buyer-account-not-found': 'buyer-not-found',
  'customers.account-deletion-already-requested': 'already-requested',
  'customers.account-deletion-in-progress': 'in-progress',
  'customers.account-deletion-request-not-found': 'request-not-found',
  'customers.account-deletion-blocked': 'blocked',
  'customers.unavailable': 'check-failed',
};

/**
 * The message key (under `account-deletion.error`) for a failed call. A step-up refusal that the
 * provider could not settle (and a cancelled one) never reach here: the screen handles those.
 */
export function deletionProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 429) return 'throttled';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/** The typed blockers of a 409 `customers.account-deletion-blocked`, ignoring any shape it lacks. */
export function blockersOf(failure: ApiFailure): readonly Blocker[] {
  const raw = (failure.details as { readonly blockers?: unknown } | undefined)?.blockers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown): Blocker[] => {
    const entry = item as { code?: unknown; count?: unknown } | null;
    if (typeof entry?.code !== 'string') return [];
    return [
      typeof entry.count === 'number'
        ? { code: entry.code, count: entry.count }
        : { code: entry.code },
    ];
  });
}
