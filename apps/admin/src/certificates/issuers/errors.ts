import type { ApiFailure } from '../../api/client.ts';

/** A message key under `certificates.issuers.error` for a refused call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'issuer.name-taken': 'name-taken',
  'issuer.accreditation-taken': 'accreditation-taken',
  'issuer.expert-approval-required': 'expert-required',
  'issuer.transition-forbidden': 'transition',
  'issuer.not-found': 'gone',
  'type.not-found': 'type-gone',
  'conflict.stale': 'stale',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'access.acting-as-refused': 'acting-as',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export interface IssuerProblem {
  /** Full message key. */
  readonly key: string;
  /** The issuer changed or vanished meanwhile: the page is read again. */
  readonly reload: boolean;
}

export function issuerProblemOf(failure: ApiFailure): IssuerProblem {
  const named = BY_CODE[failure.code];
  const key = named ?? (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown');
  return {
    key: `certificates.issuers.error.${key}`,
    reload: key === 'stale' || key === 'gone' || key === 'transition',
  };
}
