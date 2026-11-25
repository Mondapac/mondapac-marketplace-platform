import type { ApiFailure } from '../api/client.ts';

/** The key under `offer-review.flag-error` for a refused flag change. */
export function flagErrorKey(failure: ApiFailure): string {
  switch (failure.code) {
    case 'conflict.stale':
      return 'stale';
    case 'access.denied':
      return 'denied';
    case 'access.acting-as-refused':
      return 'acting-as';
    case 'second-factor.required':
    case 'second-factor.invalid':
    case 'second-factor.enrolment-required':
      return 'second-factor';
    case 'validation.failed':
      return 'invalid';
    case 'request.csrf':
      return 'csrf';
    case 'request.throttled':
      return 'throttled';
    default:
      return failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown';
  }
}
