import type { ApiFailure } from '../api/client.ts';

/** Answers that mean the page is out of date: the dialog closes and the page is read again. */
export const REFRESH_CODES: ReadonlySet<string> = new Set([
  'conflict.stale',
  'file.nothing-to-withdraw',
  'file.already-submitted',
  'seller-access.wrong-state',
]);

const PLAIN = new Set([
  'file.incomplete',
  'file.decision-in-progress',
  'request.throttled',
  'limit.daily',
  'seller-access.reapply-limit',
  'slug-lost',
]);

/** The full message key for a refused submit or withdraw. */
export function messageKeyOf(failure: ApiFailure): string {
  if (failure.code === 'slug.taken') return 'sellers.error.slug-lost';
  if (failure.status === 503 || failure.code === 'sellers.unavailable') {
    return 'sellers.error.unavailable';
  }
  if (failure.code === 'request.csrf') return 'identity.error.request.csrf';
  if (PLAIN.has(failure.code)) return `sellers.error.${failure.code}`;
  return 'identity.error.unknown';
}
