import type { ApiFailure } from '../../api/client.ts';

// The answers of the revision decisions and the photo takedown, as what the page does next
// (product version review design, board 3).

export type DecisionProblem =
  /** The version changed under the reviewer: reload to see the current one. */
  | 'stale'
  /** An approval named fewer checks than the version needs. */
  | 'checks-missing'
  /** A text holds a claim that is not allowed: send it back as a description claim. */
  | 'claim-text'
  /** The seller may not sell this, or a variant is wrong: only a send-back fits. */
  | 'send-back'
  /** The product, version or photo no longer exists. */
  | 'gone'
  | 'denied'
  | 'csrf'
  | 'throttled'
  | 'invalid'
  /** A passing failure: try again. */
  | 'retry'
  | 'unknown';

const BY_CODE: Readonly<Record<string, DecisionProblem>> = {
  'conflict.stale': 'stale',
  'review.not-current-revision': 'stale',
  'revision.base-changed': 'stale',
  'product.not-editable': 'stale',
  'review.checks-missing': 'checks-missing',
  'claim-text.refused': 'claim-text',
  'seller.not-eligible': 'send-back',
  'variant.unknown': 'send-back',
  'variant.none': 'send-back',
  'variant.limit-reached': 'send-back',
  'product.not-found': 'gone',
  'revision.not-found': 'gone',
  'image.not-found': 'gone',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
  'validation.failed': 'invalid',
  'conflict.retry': 'retry',
  'claim.check-unavailable': 'retry',
  'access.unavailable': 'retry',
};

export function decisionProblemOf(failure: ApiFailure): DecisionProblem {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'retry' : 'unknown';
}
