import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'settings.conflict': 'conflict',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
};

/** The message key (under `lists-settings.error`) for a failed call. */
export function listsProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 429) return 'throttled';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
