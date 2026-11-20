import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ListDefinition, ListPayloadFailure } from '../../lists';
import { parseSelector as parseSellerReviewSelector } from './seller-review-list-flow';
import { REVIEWS_SELLER_SAVED_FILTER_SHARE, REVIEWS_SELLER_VIEW } from '../contracts/permissions';
import { SELLER_REVIEW_SORT_KEYS, SELLER_REVIEW_VIEWS } from '../domain/seller-review-list';

// The saved filters of the seller Reviews list (CLAUDE.md rule 14), through the generic routes of
// `lists` (`lists/seller/saved-filters`, B0-1b). This module keeps the meaning of a saved filter's
// document and the keys that guard the list; `lists` keeps the table, the caps, the names and the
// sharing rules. The document is closed and mirrors the list's own selector without the page: the
// view, the search text, the reply state, the star bounds, "published in the last N days", the
// sort and its direction. A buyer is never part of it.

export const SELLER_REVIEWS_LIST_KEY = 'seller.reviews.list';

/** The "published in the last N days" choices of the filter panel. */
export const REVIEW_WITHIN_DAYS = ['7', '30', '90'] as const;
export const SELLER_REVIEW_SEARCH_MAX = 100;

/** The closed document of a saved filter, in its canonical form (an unset part is left out). */
export interface SellerReviewFilterPayload {
  readonly v: 1;
  readonly view: (typeof SELLER_REVIEW_VIEWS)[number];
  readonly q?: string;
  readonly reply?: 'none' | 'published';
  readonly minRating?: string;
  readonly maxRating?: string;
  readonly within?: (typeof REVIEW_WITHIN_DAYS)[number];
  readonly sort: (typeof SELLER_REVIEW_SORT_KEYS)[number];
  readonly direction: 'asc' | 'desc';
}

const KEYS = [
  'v',
  'view',
  'q',
  'reply',
  'minRating',
  'maxRating',
  'within',
  'sort',
  'direction',
] as const;
const RATINGS = ['1', '2', '3', '4', '5'] as const;

const invalid = (path: string, code: string): { ok: false; error: ListPayloadFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ListPayloadFailure;
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

function wordOf<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): Result<T | undefined, ListPayloadFailure> {
  const value = raw[key];
  if (!present(value)) return ok(undefined);
  if (typeof value !== 'string') return invalid(`payload.${key}`, 'type');
  const known = allowed.find((candidate) => candidate === value);
  return known === undefined ? invalid(`payload.${key}`, 'value') : ok(known);
}

/**
 * Reads a saved filter's document and returns its canonical form, or the first field it refuses
 * (`payload.<path>`, `unknown`, `type` or `value`). `view` and `sort` are required: a stored
 * filter is always resolved. A lower star bound above the upper one is refused, as the list does.
 */
export function parseSellerReviewFilterPayload(
  raw: unknown,
): Result<SellerReviewFilterPayload, ListPayloadFailure> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key)) return invalid(`payload.${key}`, 'unknown');
  }
  if (raw['v'] !== 1) return invalid('payload.v', 'value');

  if (!present(raw['view'])) return invalid('payload.view', 'required');
  const view = wordOf(raw, 'view', SELLER_REVIEW_VIEWS);
  if (!view.ok) return view;
  if (!present(raw['sort'])) return invalid('payload.sort', 'required');
  const sort = wordOf(raw, 'sort', SELLER_REVIEW_SORT_KEYS);
  if (!sort.ok) return sort;
  if (!present(raw['direction'])) return invalid('payload.direction', 'required');
  const direction = wordOf(raw, 'direction', ['asc', 'desc'] as const);
  if (!direction.ok) return direction;
  const reply = wordOf(raw, 'reply', ['none', 'published'] as const);
  if (!reply.ok) return reply;
  const minRating = wordOf(raw, 'minRating', RATINGS);
  if (!minRating.ok) return minRating;
  const maxRating = wordOf(raw, 'maxRating', RATINGS);
  if (!maxRating.ok) return maxRating;
  const within = wordOf(raw, 'within', REVIEW_WITHIN_DAYS);
  if (!within.ok) return within;
  if (
    minRating.value !== undefined &&
    maxRating.value !== undefined &&
    Number(minRating.value) > Number(maxRating.value)
  ) {
    return invalid('payload.minRating', 'value');
  }

  let q: string | undefined;
  if (present(raw['q'])) {
    if (typeof raw['q'] !== 'string') return invalid('payload.q', 'type');
    const text = raw['q'].trim();
    if (Array.from(text).length > SELLER_REVIEW_SEARCH_MAX) return invalid('payload.q', 'too-long');
    q = text === '' ? undefined : text;
  }

  // What a saved filter holds is exactly what the list accepts: the list's own closed parser reads
  // the selector (control characters, the length in characters, the star range, the Low stars cap),
  // so a filter that is shared with the store can always be applied.
  const selector: Record<string, unknown> = { view: view.value };
  if (reply.value !== undefined) selector['reply'] = reply.value;
  if (minRating.value !== undefined) selector['minRating'] = minRating.value;
  if (maxRating.value !== undefined) selector['maxRating'] = maxRating.value;
  if (q !== undefined) selector['q'] = q;
  const parsed = parseSellerReviewSelector(selector);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: 'validation.failed',
        fields: parsed.error.fields.map((field) => ({
          path: `payload.${field.path}`,
          code: field.code,
        })),
      },
    };
  }

  // The caller checked each part above; `view`, `sort` and `direction` are always set here.
  return ok({
    v: 1,
    view: view.value ?? 'all',
    ...(q === undefined ? {} : { q }),
    ...(reply.value === undefined ? {} : { reply: reply.value }),
    ...(minRating.value === undefined ? {} : { minRating: minRating.value }),
    ...(maxRating.value === undefined ? {} : { maxRating: maxRating.value }),
    ...(within.value === undefined ? {} : { within: within.value }),
    sort: sort.value ?? 'published',
    direction: direction.value ?? 'desc',
  });
}

/**
 * The lists reviews registers with `lists` (`registerLists('reviews', ...)`): the seller Reviews
 * list, one set of filters per store, guarded by `reviews.seller.view`; sharing a filter with the
 * store needs the module's own share key.
 */
export const REVIEWS_LISTS: readonly ListDefinition[] = [
  {
    listKey: SELLER_REVIEWS_LIST_KEY,
    population: 'seller',
    scope: 'store',
    viewKey: REVIEWS_SELLER_VIEW.key,
    shareKey: REVIEWS_SELLER_SAVED_FILTER_SHARE.key,
    parsePayload: (raw) => parseSellerReviewFilterPayload(raw),
  },
];
