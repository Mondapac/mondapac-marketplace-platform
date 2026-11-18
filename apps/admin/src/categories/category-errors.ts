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
  /** Values of a restructure message (`max`, `n`, `types`); see `restructureProblemOf`. */
  readonly values?: Readonly<Record<string, string | number>>;
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
  'file.too-large',
  'file.unsupported-type',
  'file.too-many-pixels',
  'file.too-small',
  'file.unreadable',
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

export function categoryProblemOf(
  failure: ApiFailure,
  method: 'POST' | 'PUT' | 'PATCH' = 'POST',
  namesCategoryVersion: boolean = method !== 'POST',
): CategoryProblem {
  const code = KNOWN.has(failure.code) ? failure.code : 'unknown';
  const fields: Record<string, string> = {};
  for (const field of failure.details?.fields ?? []) fields[field.path] = field.code;
  // One API code, two texts (amendment 7): a details save (PATCH) and the image writes name the
  // category version, every other write names the tree version.
  const named =
    code === 'conflict.stale'
      ? `conflict.stale.${namesCategoryVersion ? 'details' : 'tree'}`
      : code;
  return {
    key: `categories.error.${named.replace(/\./g, '_')}`,
    fields,
    reload: RELOAD.has(code),
    ...(failure.details?.max === undefined ? {} : { max: failure.details.max }),
  };
}

/** Codes of Move, Merge and Archive (categories C4a) that have their own words under `categories.restructure.error`. */
const RESTRUCTURE_CODES = new Set([
  'category.cycle',
  'category.depth-exceeded',
  'category.referenced-by-policy',
  'category.check-unavailable',
  'category.impact-too-large',
  'category.only-platform-category',
  'category.products-on-upper-level',
  'category.has-subcategories',
  'category.move-unchanged',
  'category.target-not-found',
  'category.parent-not-found',
]);
/** The codes after which the page read old data. */
const RESTRUCTURE_RELOAD = new Set([
  'conflict.stale',
  'category.target-not-found',
  'category.parent-not-found',
  'category.not-found',
]);

/**
 * What a refused Move, Merge or Archive shows. A code of the table of categories C4a has its own
 * words; a reason problem is worded for the reason field; any other code is worded as in C3.
 */
export function restructureProblemOf(failure: ApiFailure): CategoryProblem {
  const reasonProblem =
    failure.code === 'validation.failed' &&
    (failure.details?.fields ?? []).some((field) => field.path === 'reason');
  if (reasonProblem) {
    return { key: 'categories.restructure.error.reason', fields: {}, reload: false };
  }
  if (!RESTRUCTURE_CODES.has(failure.code)) {
    const base = categoryProblemOf(failure);
    return RESTRUCTURE_RELOAD.has(failure.code) ? { ...base, reload: true } : base;
  }
  const values: Record<string, string | number> = {};
  if (failure.details?.max !== undefined) values['max'] = failure.details.max;
  if (failure.details?.total !== undefined) values['n'] = failure.details.total;
  if (failure.details?.typeCodes !== undefined)
    values['types'] = failure.details.typeCodes.join(', ');
  return {
    key: `categories.restructure.error.${failure.code.replace(/\./g, '_')}`,
    fields: {},
    reload: RESTRUCTURE_RELOAD.has(failure.code),
    values,
  };
}

/** Codes of Move products (categories C5a) that have their own words under `categories.move-products.error`. */
const MOVE_PRODUCTS_CODES = new Set([
  'category.not-found',
  'category.target-not-found',
  'category.move-unchanged',
  'category.level-not-allowed',
  'category.not-editable',
  'category.no-products',
  'category.move-in-progress',
]);
/** The codes after which the page read old data. */
const MOVE_PRODUCTS_RELOAD = new Set([
  'category.not-found',
  'category.target-not-found',
  'category.not-editable',
]);

/**
 * What a refused Move products shows: a code of the table has its own words, a reason problem is
 * worded for the reason field, any other code is worded as in C3.
 */
export function moveProductsProblemOf(failure: ApiFailure): CategoryProblem {
  if (MOVE_PRODUCTS_CODES.has(failure.code)) {
    return {
      key: `categories.move-products.error.${failure.code.replace(/\./g, '_')}`,
      fields: {},
      reload: MOVE_PRODUCTS_RELOAD.has(failure.code),
    };
  }
  const reasonProblem =
    failure.code === 'validation.failed' &&
    (failure.details?.fields ?? []).some((field) => field.path === 'reason');
  if (reasonProblem) {
    return { key: 'categories.restructure.error.reason', fields: {}, reload: false };
  }
  return categoryProblemOf(failure);
}
