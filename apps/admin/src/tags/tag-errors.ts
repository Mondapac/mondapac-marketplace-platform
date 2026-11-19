import type { ApiFailure } from '../api/client.ts';

/** A message key under `tags.error` for a refused call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'topic.claim-word': 'claim-word',
  'topic.locale-uncheckable': 'locale-uncheckable',
  'topic.slug-taken': 'slug-taken',
  'topic.term-taken': 'term-taken',
  'topic.not-found': 'gone',
  'conflict.stale': 'stale',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export interface TagField {
  /** Path the API refused: `names.<locale>`, `synonyms.<locale>.<n>`, `intro`, `slug`, ... */
  readonly path: string;
  /** The API's reason (`claim-word`, `too-long`, `taken`, ...). */
  readonly code: string;
}

export interface TagProblem {
  /** Full message key. */
  readonly key: string;
  /** The tag changed or vanished meanwhile: the list is read again. */
  readonly reload: boolean;
  readonly fields: readonly TagField[];
}

export function tagProblemOf(failure: ApiFailure): TagProblem {
  const named = BY_CODE[failure.code];
  const key = named ?? (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown');
  const fields: TagField[] = (failure.details?.fields ?? []).map((field) => ({
    path: field.path,
    code: field.code,
  }));
  // The slug conflict names no field: it belongs on the slug.
  if (failure.code === 'topic.slug-taken' && !fields.some((field) => field.path === 'slug')) {
    fields.push({ path: 'slug', code: 'slug-taken' });
  }
  return {
    key: `tags.error.${key}`,
    reload: key === 'gone' || key === 'stale',
    fields,
  };
}
