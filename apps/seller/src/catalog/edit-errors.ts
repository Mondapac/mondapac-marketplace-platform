import type { ApiFailure } from '../api/client.ts';

export interface EditProblem {
  /** Full message key. */
  readonly key: string;
  readonly values?: Record<string, string | number>;
  /** `path: code` lines of the draft or text the API refused, shown as plain text. */
  readonly details: readonly string[];
  /** The screen is stale: the seller should read the product again. */
  readonly reload: boolean;
}

const BY_CODE: Readonly<Record<string, string>> = {
  'claim-text.refused': 'claim-text',
  'revision.not-ready': 'not-ready',
  'working-copy.invalid-content': 'invalid-content',
  'working-copy.not-found': 'no-draft',
  'conflict.stale': 'stale',
  'product.not-editable': 'not-editable',
  'product.not-a-draft': 'not-editable',
  'product.not-found': 'not-found',
  'variant.id-taken': 'variant',
  'variant.unknown': 'variant',
  'variant.fixed': 'variant',
  'variant.limit-reached': 'variant',
  'variant.not-found': 'variant',
  'variant.not-proposed': 'variant',
  'variant.none': 'variant',
  'seller.not-eligible': 'not-eligible',
  'access.denied': 'denied',
};

const RELOAD = new Set(['stale', 'not-editable', 'not-found', 'no-draft']);

export function editProblemOf(failure: ApiFailure): EditProblem {
  const lines = [...(failure.details?.fields ?? []), ...(failure.details?.issues ?? [])].map(
    (item) => `${item.path}: ${item.code}`,
  );
  const named = BY_CODE[failure.code];
  const name =
    named ??
    (failure.code === 'request.throttled'
      ? 'throttled'
      : failure.code === 'validation.failed'
        ? 'invalid'
        : failure.code === 'request.csrf'
          ? 'csrf'
          : failure.status === 503 || failure.status === 0
            ? 'unavailable'
            : 'unknown');
  const values: Record<string, string | number> = {};
  if (failure.details?.max !== undefined) values['max'] = failure.details.max;
  if (failure.details?.retryAfterSeconds !== undefined) {
    values['seconds'] = failure.details.retryAfterSeconds;
  }
  return {
    key: `catalog.edit.error.${name}`,
    ...(Object.keys(values).length > 0 ? { values } : {}),
    details: lines,
    reload: RELOAD.has(name),
  };
}
