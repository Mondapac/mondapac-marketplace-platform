import type { ApiFailure } from '../api/client.ts';

/** What a refused category write shows: a message key, field problems and what to do next. */
export interface CategoryProblem {
  /** A key under `categories.error`: the code with `.` turned into `_` (a message key has no dots). */
  readonly key: string;
  /** Field problems by path, to a code under `categories.form.error`. */
  readonly fields: Readonly<Record<string, string>>;
  /** The page read old data: read it again before trying. */
  readonly reload: boolean;
  /** `category.depth-exceeded` and `category.cascade-too-large`: the limit. */
  readonly max?: number;
}

const KNOWN = new Set([
  'category.not-found',
  'category.parent-not-found',
  'category.slug-taken',
  'category.slug-unchanged',
  'category.sibling-name-taken',
  'category.already-hidden',
  'category.not-hidden',
  'category.parent-hidden',
  'category.not-editable',
  'category.reorder-edge',
  'category.not-discardable',
  'category.depth-exceeded',
  'category.required-locale-missing',
  'category.cascade-too-large',
  'category.claim-word',
  'category.locale-uncheckable',
  'claim-text.check-unavailable',
  'conflict.stale',
  'validation.failed',
  'access.permission-missing',
  'access.acting-as-refused',
  'access.unavailable',
  'catalog.categories-unavailable',
]);

const RELOAD = new Set([
  'conflict.stale',
  'category.not-found',
  'category.already-hidden',
  'category.not-hidden',
  'category.not-editable',
  'category.not-discardable',
  'category.reorder-edge',
]);

export function categoryProblemOf(failure: ApiFailure): CategoryProblem {
  const code = KNOWN.has(failure.code) ? failure.code : 'unknown';
  const fields: Record<string, string> = {};
  for (const field of failure.details?.fields ?? []) fields[field.path] = field.code;
  return {
    key: `categories.error.${code.replace(/\./g, '_')}`,
    fields,
    reload: RELOAD.has(code),
    ...(failure.details?.max === undefined ? {} : { max: failure.details.max }),
  };
}
