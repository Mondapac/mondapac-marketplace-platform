import type { ApiFailure } from '../../api/client.ts';

/** A message key under `certificates.requests.error` for a refused call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'issuer-request.not-found': 'gone',
  'issuer-request.already-answered': 'answered',
  'issuer-request.reason-unknown': 'reason',
  'issuer.not-active': 'issuer-not-active',
  'issuer.not-found': 'issuer-gone',
  'conflict.stale': 'stale',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'access.acting-as-refused': 'acting-as',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export interface RequestProblem {
  /** Full message key. */
  readonly key: string;
  /** The request changed meanwhile: the page is read again. */
  readonly reload: boolean;
}

export function requestProblemOf(failure: ApiFailure): RequestProblem {
  const named = Object.hasOwn(BY_CODE, failure.code) ? BY_CODE[failure.code] : undefined;
  const key = named ?? (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown');
  return {
    key: `certificates.requests.error.${key}`,
    reload: key === 'stale' || key === 'answered' || key === 'gone' || key === 'issuer-gone',
  };
}
