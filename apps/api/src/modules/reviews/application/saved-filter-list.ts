import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ListDefinition, ListPayloadFailure } from '../../lists';
import { REVIEWS_SELLER_VIEW } from '../contracts/permissions';
import {
  SELLER_REVIEW_SORT_KEYS,
  SELLER_REVIEW_VIEWS,
  type SellerReviewSortKey,
  type SellerReviewView_,
} from '../domain/seller-review-list';

// The saved filters of the seller's Reviews list (super list phase 3, list 32; CLAUDE.md rule 14),
// through the generic routes of `lists` (`lists/seller/saved-filters`). This module keeps the
// meaning of a saved filter's document and the key that guards the list; `lists` keeps the table,
// the caps and the names. The document is closed: the view, the star range, the days, the sort and
// its direction. The search text and a pasted id are never saved (they name one review). The list
// is private to the shop's user: it has no share key.

export const SELLER_REVIEWS_LIST_KEY = 'seller.reviews.reviews';

/** The closed document of a saved filter, in its canonical form (an empty part is left out). */
export interface SellerReviewFilterPayload {
  readonly v: 1;
  readonly view: SellerReviewView_;
  readonly filters?: {
    readonly minRating?: number;
    readonly maxRating?: number;
    /** Calendar days (`YYYY-MM-DD`) on the seller's clock; the panel turns them into instants. */
    readonly from?: string;
    readonly to?: string;
  };
  readonly sort?: SellerReviewSortKey;
  readonly direction?: 'asc' | 'desc';
}

const TOP_KEYS = ['v', 'view', 'filters', 'sort', 'direction'] as const;
const FILTER_KEYS = ['minRating', 'maxRating', 'from', 'to'] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day: 2026-02-31 is refused, not rolled over to March. */
const isDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' });
    return true;
  } catch {
    return false;
  }
};

const invalid = (path: string, code: string): { ok: false; error: ListPayloadFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ListPayloadFailure;
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStars = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;

/**
 * Reads a saved filter's document and returns its canonical form, or the first field it refuses
 * (`payload.<path>`, `unknown`, `type` or `value`). A top star count below the lowest one, or an
 * end day before the start day, is refused: the list itself refuses those ranges.
 */
export function parseSellerReviewFilterPayload(
  raw: unknown,
): Result<SellerReviewFilterPayload, ListPayloadFailure> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw)) {
    if (!(TOP_KEYS as readonly string[]).includes(key)) return invalid(`payload.${key}`, 'unknown');
  }
  if (raw['v'] !== 1) return invalid('payload.v', 'value');
  const view = raw['view'];
  if (typeof view !== 'string') return invalid('payload.view', 'type');
  const knownView = SELLER_REVIEW_VIEWS.find((candidate) => candidate === view);
  if (knownView === undefined) return invalid('payload.view', 'value');

  const filters: { minRating?: number; maxRating?: number; from?: string; to?: string } = {};
  const given = raw['filters'];
  if (given !== undefined && given !== null) {
    if (!isRecord(given)) return invalid('payload.filters', 'type');
    for (const key of Object.keys(given)) {
      if (!(FILTER_KEYS as readonly string[]).includes(key)) {
        return invalid(`payload.filters.${key}`, 'unknown');
      }
    }
    for (const field of ['minRating', 'maxRating'] as const) {
      const stars = given[field];
      if (stars === undefined || stars === null) continue;
      if (!isStars(stars)) return invalid(`payload.filters.${field}`, 'value');
      filters[field] = stars;
    }
    if (
      filters.minRating !== undefined &&
      filters.maxRating !== undefined &&
      filters.maxRating < filters.minRating
    ) {
      return invalid('payload.filters.maxRating', 'value');
    }
    for (const field of ['from', 'to'] as const) {
      const day = given[field];
      if (day === undefined || day === null || day === '') continue;
      if (!isDay(day)) return invalid(`payload.filters.${field}`, 'value');
      filters[field] = day;
    }
    if (filters.from !== undefined && filters.to !== undefined && filters.to < filters.from) {
      return invalid('payload.filters.to', 'value');
    }
  }

  const sort = raw['sort'];
  let knownSort: SellerReviewSortKey | undefined;
  if (sort !== undefined && sort !== null) {
    knownSort = SELLER_REVIEW_SORT_KEYS.find((candidate) => candidate === sort);
    if (knownSort === undefined) return invalid('payload.sort', 'value');
  }
  const direction = raw['direction'];
  if (
    direction !== undefined &&
    direction !== null &&
    direction !== 'asc' &&
    direction !== 'desc'
  ) {
    return invalid('payload.direction', 'value');
  }

  const ordered = Object.fromEntries(
    FILTER_KEYS.flatMap((key) => (filters[key] === undefined ? [] : [[key, filters[key]]])),
  ) as SellerReviewFilterPayload['filters'];
  return ok({
    v: 1,
    view: knownView,
    ...(Object.keys(ordered ?? {}).length === 0 ? {} : { filters: ordered }),
    ...(knownSort === undefined ? {} : { sort: knownSort }),
    ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
  });
}

/**
 * The lists reviews registers with `lists` (`registerLists('reviews', ...)`): the seller's Reviews
 * list, guarded by its own view key. A seller's filter is never shared, so there is no share key.
 */
export const REVIEWS_LISTS: readonly ListDefinition[] = [
  {
    listKey: SELLER_REVIEWS_LIST_KEY,
    population: 'seller',
    viewKey: REVIEWS_SELLER_VIEW.key,
    parsePayload: (raw) => parseSellerReviewFilterPayload(raw),
  },
];
