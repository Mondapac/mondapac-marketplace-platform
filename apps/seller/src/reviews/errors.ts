import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'reviews.already-replied': 'already-replied',
  'reviews.edit-window-closed': 'edit-window-closed',
  'reviews.not-editable': 'edit-window-closed',
  'reviews.not-found': 'not-found',
  'reviews.disabled': 'not-found',
  'request.throttled': 'throttled',
  'reviews.rate-limited': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message key (under `reviews.error`) for a failed reply, edit or report. */
export function reviewProblemOf(failure: ApiFailure): string {
  if (failure.code === 'validation.failed') {
    // A text with contact details, a link or a blocked word is refused, not held.
    return failure.details?.fields?.some((field) => field.code === 'not-allowed')
      ? 'not-allowed'
      : 'invalid';
  }
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
