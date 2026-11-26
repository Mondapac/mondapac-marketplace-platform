import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'settings.conflict': 'conflict',
  'access.denied': 'denied',
  'access.acting-as-refused': 'acting-as',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
  // Switching on needs a two-step code (G4d3); the dialog asks, this is what is left after it.
  'second-factor.required': 'second-factor',
  'second-factor.enrolment-required': 'second-factor',
};

/** The message key (under `ai-settings.error`) for a failed call. */
export function aiProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 429) return 'throttled';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
