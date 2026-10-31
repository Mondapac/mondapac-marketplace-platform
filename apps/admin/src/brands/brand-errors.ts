import type { ApiFailure } from '../api/client.ts';

/** A message key under `brands.error` for a refused call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'brand.slug-invalid': 'slug-invalid',
  'brand.slug-taken': 'slug-taken',
  'brand.slug-locked': 'slug-locked',
  'brand.near-duplicate': 'near-duplicate',
  'brand.alias-taken': 'alias-taken',
  'brand.not-found': 'gone',
  'brand-merge-queue.group-not-found': 'gone',
  'brand.not-draft': 'stale',
  'brand.archived': 'stale',
  'brand.already-archived': 'stale',
  'brand.merge-target-not-active': 'stale',
  'brand.merge-source-archived': 'stale',
  'brand.merge-into-itself': 'into-itself',
  'conflict.stale': 'stale',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export interface BrandProblem {
  /** Full message key. */
  readonly key: string;
  /** The brand changed or vanished meanwhile: the list is read again. */
  readonly reload: boolean;
  /** Live brands the name looks like (`brand.near-duplicate`, `brand.alias-taken`). */
  readonly similar: readonly string[];
  /** Paths of the fields the API refused (`validation.failed`). */
  readonly fields: readonly string[];
}

function namesOf(failure: ApiFailure): readonly string[] {
  const brands = (failure.details as { readonly brands?: unknown } | undefined)?.brands;
  if (!Array.isArray(brands)) return [];
  return brands
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string')
    .slice(0, 5);
}

export function brandProblemOf(failure: ApiFailure): BrandProblem {
  const named = BY_CODE[failure.code];
  const key = named ?? (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown');
  return {
    key: `brands.error.${key}`,
    reload: key === 'gone' || key === 'stale',
    similar: namesOf(failure),
    fields: (failure.details?.fields ?? []).map((field) => field.path),
  };
}
