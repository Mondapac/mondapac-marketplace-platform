import type { ApiFailure } from '../../api/client.ts';

export interface FormProblem {
  /** Key under `catalog.productForm.error`. */
  readonly key: string;
  readonly values?: Record<string, string | number>;
  /** `path: code` lines of the draft or text the API refused, shown as plain text. */
  readonly details: readonly string[];
  /** The screen is stale: the admin should read the product again. */
  readonly reload: boolean;
}

const BY_CODE: Readonly<Record<string, string>> = {
  'claim-text.refused': 'claim-text',
  'revision.not-ready': 'not-ready',
  'revision.pending-exists': 'stale',
  'revision.base-changed': 'stale',
  'working-copy.invalid-content': 'invalid-content',
  'working-copy.not-found': 'no-draft',
  'conflict.stale': 'stale',
  'product.not-editable': 'not-editable',
  'product.not-a-draft': 'not-editable',
  'product.not-found': 'not-found',
  'product.type-not-offered': 'type-not-offered',
  'variant.id-taken': 'variant',
  'variant.unknown': 'variant',
  'variant.fixed': 'variant',
  'variant.limit-reached': 'variant',
  'variant.not-found': 'variant',
  'variant.not-proposed': 'variant',
  'variant.none': 'variant',
  'access.denied': 'denied',
};

const RELOAD = new Set(['stale', 'not-editable', 'not-found', 'no-draft']);

export function problemOf(failure: ApiFailure): FormProblem {
  const lines = [...(failure.details?.fields ?? []), ...(failure.details?.issues ?? [])].map(
    (item) => `${item.path}: ${item.code}`,
  );
  const name =
    BY_CODE[failure.code] ??
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
    key: name,
    ...(Object.keys(values).length > 0 ? { values } : {}),
    details: lines,
    reload: RELOAD.has(name),
  };
}
