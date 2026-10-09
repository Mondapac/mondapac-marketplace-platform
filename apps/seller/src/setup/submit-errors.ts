import type { ApiFailure } from '../api/client.ts';

/**
 * Answers that mean the page is out of date: the dialog closes and the page is read again, with
 * no error shown (the page now says where the file stands).
 */
export const REFRESH_CODES: ReadonlySet<string> = new Set([
  'conflict.stale',
  'file.nothing-to-withdraw',
  'file.already-submitted',
  'seller-access.wrong-state',
]);

/** Refusals that keep their own message under `sellers.error`. */
const PLAIN = new Set([
  'file.incomplete',
  'file.decision-in-progress',
  'file.change-request-required',
  'request.throttled',
  'lookup.limit',
  'address.outside-service-area',
  'seller-access.reapply-limit',
]);

/** The full message key for a refused submit or withdraw. */
export function messageKeyOf(failure: ApiFailure): string {
  switch (failure.code) {
    case 'slug.taken':
      return 'sellers.error.slug-lost';
    case 'slug.reserved':
      return 'sellers.error.slug.reserved';
    case 'slug.format':
    case 'validation.failed':
      return 'sellers.validation.invalid';
    case 'identifier.not-matched':
      return 'sellers.number.status.not-matched';
    case 'request.csrf':
      return 'identity.error.request.csrf';
    default:
      break;
  }
  if (failure.status === 503 || failure.code === 'sellers.unavailable') {
    return 'sellers.error.unavailable';
  }
  if (PLAIN.has(failure.code)) return `sellers.error.${failure.code}`;
  return 'identity.error.unknown';
}
