import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'shipping.fleet-model-name-taken': 'name-taken',
  'shipping.fleet-model-conflict': 'conflict',
  'shipping.fleet-selection-conflict': 'page-conflict',
  'shipping.fleet-model-not-found': 'not-found',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message key (under `fleets.error`) for a failed write. */
export function fleetProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
