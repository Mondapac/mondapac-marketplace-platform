import type { ApiFailure } from '../api/client.ts';

/** A message key under `sellers.decision.error` for a refused decision or check, or null for none. */
const BY_CODE: Readonly<Record<string, string>> = {
  'review.not-current-revision': 'not-current',
  'review.identifier-claimed': 'identifier-claimed',
  'review.register-negative': 'register-negative',
  'review.manual-register-check-required': 'check-required',
  'seller-access.owner-unverified': 'owner-unverified',
  'seller-access.wrong-state': 'wrong-state',
  'seller-access.reason-required': 'reason-required',
  'file.decision-in-progress': 'in-progress',
  'file.not-found': 'not-found',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
};

export interface DecisionProblem {
  /** Full message key. */
  readonly key: string;
  /** True when the screen is stale and the reviewer should read the application again. */
  readonly reload: boolean;
  readonly reasonInvalid: boolean;
}

export function decisionProblemOf(failure: ApiFailure): DecisionProblem {
  const reasonInvalid =
    failure.code === 'seller-access.reason-required' ||
    (failure.code === 'validation.failed' &&
      (failure.details?.fields ?? []).some((field) => field.path === 'reason'));
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
  return {
    key: `sellers.decision.error.${key}`,
    reload: ['not-current', 'wrong-state', 'in-progress', 'not-found'].includes(key),
    reasonInvalid,
  };
}
