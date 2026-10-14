import type { ApiFailure } from '../api/client.ts';

export interface PayoutProblem {
  /** Key under `payout.error`. */
  readonly key: string;
  readonly minutes?: number;
}

const BY_CODE: Readonly<Record<string, string>> = {
  'second-factor.invalid': 'invalid',
  'payments.payout-account.second-factor-required': 'second-factor-required',
  'payments.unavailable': 'unavailable',
  'validation.failed': 'invalid',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message for a refused connect or link call; the code field decides, never the status. */
export function payoutProblemOf(failure: ApiFailure): PayoutProblem {
  if (failure.code === 'second-factor.locked' || failure.code === 'request.throttled') {
    const seconds = failure.details?.retryAfterSeconds ?? 60;
    return {
      key: failure.code === 'request.throttled' ? 'throttled' : 'locked',
      minutes: Math.max(1, Math.ceil(seconds / 60)),
    };
  }
  const named = BY_CODE[failure.code];
  if (named !== undefined) return { key: named };
  return { key: failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown' };
}
