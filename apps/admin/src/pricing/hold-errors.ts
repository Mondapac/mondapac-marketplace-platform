import type { ApiFailure } from '../api/client.ts';

/** A message key under `pricing.holds.error` for a refused decision. */
const BY_CODE: Readonly<Record<string, string>> = {
  'pricing.hold.own-submission': 'own-submission',
  'pricing.hold.not-found': 'gone',
  'pricing.hold.not-pending': 'gone',
  'pricing.series-retired': 'retired',
  'pricing.amount-out-of-range': 'out-of-range',
  'pricing.currency-mismatch': 'out-of-range',
  'conflict.stale': 'retry',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
};

export interface HoldProblem {
  /** Full message key. */
  readonly key: string;
  /** True when the record is no longer pending, so its row leaves the queue. */
  readonly gone: boolean;
}

export function holdProblemOf(failure: ApiFailure): HoldProblem {
  const named = BY_CODE[failure.code];
  const key =
    named !== undefined
      ? named
      : failure.code === 'validation.failed'
        ? 'invalid'
        : failure.status === 503 || failure.status === 0
          ? 'unavailable'
          : failure.code === 'request.csrf'
            ? 'csrf'
            : 'unknown';
  return { key: `pricing.holds.error.${key}`, gone: key === 'gone' };
}
