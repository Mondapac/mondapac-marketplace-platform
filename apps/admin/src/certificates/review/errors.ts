import type { ApiFailure } from '../../api/client.ts';

/** A message key under `certificates.review.error` for a refused call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'certificate.not-found': 'gone',
  'review.not-current-submission': 'replaced',
  'review.checks-incomplete': 'checks',
  'review.checks-missing': 'checks',
  'seller.zone-missing': 'zone',
  'type.inactive': 'type-inactive',
  'review.scope-missing': 'scope',
  'review.issuer-not-accepting': 'issuer',
  'certificate.expired': 'expired',
  'issuer.not-active': 'issuer',
  'certificate.incomplete': 'incomplete',
  'certificate.already-expired': 'expired',
  'conflict.stale': 'stale',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'access.acting-as-refused': 'acting-as',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export interface ReviewProblem {
  /** Full message key. */
  readonly key: string;
  /** The record changed meanwhile: the page is read again. */
  readonly reload: boolean;
}

export function reviewProblemOf(failure: ApiFailure): ReviewProblem {
  const named = Object.hasOwn(BY_CODE, failure.code) ? BY_CODE[failure.code] : undefined;
  const key = named ?? (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown');
  return {
    key: `certificates.review.error.${key}`,
    reload: key === 'stale' || key === 'gone' || key === 'replaced',
  };
}
