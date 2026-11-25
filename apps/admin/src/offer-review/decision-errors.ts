import type { ApiFailure } from '../api/client.ts';

/** What a refused decision tells the reviewer; `key` is under `offer-review.decide.error`. */
export interface DecisionProblem {
  readonly key:
    | 'stale'
    | 'gone'
    | 'own'
    | 'denied'
    | 'claim'
    | 'tag'
    | 'seller'
    | 'invalid'
    | 'throttled'
    | 'csrf'
    | 'unavailable'
    | 'unknown';
  /** The row changed or was decided: the list reads again and the reviewer reloads it. */
  readonly reload: boolean;
}

const BY_CODE: Readonly<Record<string, DecisionProblem['key']>> = {
  'conflict.stale': 'stale',
  'conflict.retry': 'stale',
  'offer-change.not-pending': 'gone',
  'offer-change.not-found': 'gone',
  'offer.not-pending-review': 'gone',
  'offer.not-found': 'gone',
  'offer-change.own-submission': 'own',
  'access.denied': 'denied',
  'claim-text.refused': 'claim',
  'claim.tag-not-allowed': 'tag',
  'offer-change.invalid': 'invalid',
  'seller.not-eligible': 'seller',
  'type.not-allowed': 'seller',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export function decisionProblemOf(failure: ApiFailure): DecisionProblem {
  const named = BY_CODE[failure.code];
  const key =
    named ??
    (failure.code === 'validation.failed'
      ? 'invalid'
      : failure.status === 0 || failure.status >= 500
        ? 'unavailable'
        : 'unknown');
  return { key, reload: key === 'stale' || key === 'gone' };
}
