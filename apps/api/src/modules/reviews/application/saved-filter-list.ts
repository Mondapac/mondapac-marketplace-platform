import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ListDefinition, ListPayloadFailure } from '../../lists';
import {
  REVIEWS_MODERATION_QUEUE,
  REVIEWS_SAVED_FILTER_SHARE,
  REVIEWS_SELLER_VIEW,
} from '../contracts/permissions';
import {
  MODERATION_LIST_VIEWS,
  MODERATION_SORT_KEYS,
  type ModerationListView,
  type ModerationSortKey,
} from '../domain/moderation-list';
import {
  SELLER_REVIEW_SORT_KEYS,
  SELLER_REVIEW_VIEWS,
  type SellerReviewSortKey,
  type SellerReviewView_,
} from '../domain/seller-review-list';

// The saved filters of the review lists (super list phase 3, lists 32 and 18; CLAUDE.md rule 14),
// through the generic routes of `lists`. This module keeps the meaning of a saved filter's
// document and the keys that guard each list; `lists` keeps the table, the caps, the names and the
// sharing rules. Each document is closed: the view, the star range ("1" to "5", as the panel keeps
// them), a date preset, the sort and its direction (the moderation list adds the report reason).
// The search text, a pasted id and the seller link are never saved. The seller's list is private
// to the shop's user (no share key); the moderation list may be shared with the share key.

export const SELLER_REVIEWS_LIST_KEY = 'seller.reviews.reviews';
export const MODERATION_LIST_KEY = 'admin.reviews.moderation';

/**
 * The date presets a saved filter may hold. The panel turns one into instants on its own clock when
 * it applies the filter, so a saved "Last 7 days" keeps meaning the last seven days. Same ids as
 * the panel's date presets.
 */
export const REVIEW_DATE_PRESETS = [
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
  'this-month',
  'last-month',
] as const;
export type ReviewDatePreset = (typeof REVIEW_DATE_PRESETS)[number];

const STARS = ['1', '2', '3', '4', '5'] as const;
type Stars = (typeof STARS)[number];
const REASON_CODE = /^[a-z][a-z-]{0,39}$/;
const TOP_KEYS = ['v', 'view', 'filters', 'sort', 'direction'] as const;

/** The closed filters of a document, in canonical key order. */
interface ReviewFilters {
  readonly minRating?: Stars;
  readonly maxRating?: Stars;
  readonly reportReason?: string;
  readonly published?: ReviewDatePreset;
  readonly submitted?: ReviewDatePreset;
}

export interface SellerReviewFilterPayload {
  readonly v: 1;
  readonly view: SellerReviewView_;
  readonly filters?: Pick<ReviewFilters, 'minRating' | 'maxRating' | 'published'>;
  readonly sort?: SellerReviewSortKey;
  readonly direction?: 'asc' | 'desc';
}

export interface ModerationFilterPayload {
  readonly v: 1;
  readonly view: ModerationListView;
  readonly filters?: Pick<
    ReviewFilters,
    'minRating' | 'maxRating' | 'reportReason' | 'submitted'
  >;
  readonly sort?: ModerationSortKey;
  readonly direction?: 'asc' | 'desc';
}

const invalid = (path: string, code: string): { ok: false; error: ListPayloadFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ListPayloadFailure;
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStars = (value: unknown): value is Stars =>
  typeof value === 'string' && (STARS as readonly string[]).includes(value);

const isPreset = (value: unknown): value is ReviewDatePreset =>
  typeof value === 'string' && (REVIEW_DATE_PRESETS as readonly string[]).includes(value);

interface ListShape<View extends string, Sort extends string> {
  readonly views: readonly View[];
  readonly sorts: readonly Sort[];
  /** The filter keys this list accepts, in canonical order; `date` names its preset key. */
  readonly filterKeys: readonly (keyof ReviewFilters)[];
}

/**
 * Reads a saved filter's document of one review list and returns its canonical form, or the first
 * field it refuses (`payload.<path>`, `unknown`, `type` or `value`). A top star count below the
 * lowest one is refused: the list itself refuses that range.
 */
function parseReviewDocument<View extends string, Sort extends string>(
  raw: unknown,
  shape: ListShape<View, Sort>,
): Result<
  {
    readonly v: 1;
    readonly view: View;
    readonly filters?: ReviewFilters;
    readonly sort?: Sort;
    readonly direction?: 'asc' | 'desc';
  },
  ListPayloadFailure
> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw)) {
    if (!(TOP_KEYS as readonly string[]).includes(key)) return invalid(`payload.${key}`, 'unknown');
  }
  if (raw['v'] !== 1) return invalid('payload.v', 'value');
  const view = raw['view'];
  if (typeof view !== 'string') return invalid('payload.view', 'type');
  const knownView = shape.views.find((candidate) => candidate === view);
  if (knownView === undefined) return invalid('payload.view', 'value');

  const filters: { -readonly [K in keyof ReviewFilters]: ReviewFilters[K] } = {};
  const given = raw['filters'];
  if (given !== undefined && given !== null) {
    if (!isRecord(given)) return invalid('payload.filters', 'type');
    for (const key of Object.keys(given)) {
      if (!(shape.filterKeys as readonly string[]).includes(key)) {
        return invalid(`payload.filters.${key}`, 'unknown');
      }
    }
    for (const field of ['minRating', 'maxRating'] as const) {
      const stars = given[field];
      if (stars === undefined || stars === null || stars === '') continue;
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
    const reason = given['reportReason'];
    if (reason !== undefined && reason !== null && reason !== '') {
      if (typeof reason !== 'string' || !REASON_CODE.test(reason)) {
        return invalid('payload.filters.reportReason', 'value');
      }
      filters.reportReason = reason;
    }
    for (const field of ['published', 'submitted'] as const) {
      const preset = given[field];
      if (preset === undefined || preset === null || preset === '') continue;
      if (!isPreset(preset)) return invalid(`payload.filters.${field}`, 'value');
      filters[field] = preset;
    }
  }

  const sort = raw['sort'];
  let knownSort: Sort | undefined;
  if (sort !== undefined && sort !== null) {
    knownSort = shape.sorts.find((candidate) => candidate === sort);
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
    shape.filterKeys.flatMap((key) => (filters[key] === undefined ? [] : [[key, filters[key]]])),
  ) as ReviewFilters;
  return ok({
    v: 1,
    view: knownView,
    ...(Object.keys(ordered).length === 0 ? {} : { filters: ordered }),
    ...(knownSort === undefined ? {} : { sort: knownSort }),
    ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
  });
}

/** Reads a saved document of the seller's Reviews list, in its canonical form. */
export function parseSellerReviewFilterPayload(
  raw: unknown,
): Result<SellerReviewFilterPayload, ListPayloadFailure> {
  return parseReviewDocument(raw, {
    views: SELLER_REVIEW_VIEWS,
    sorts: SELLER_REVIEW_SORT_KEYS,
    filterKeys: ['minRating', 'maxRating', 'published'],
  });
}

/** Reads a saved document of the admin moderation list, in its canonical form. */
export function parseModerationFilterPayload(
  raw: unknown,
): Result<ModerationFilterPayload, ListPayloadFailure> {
  return parseReviewDocument(raw, {
    views: MODERATION_LIST_VIEWS,
    sorts: MODERATION_SORT_KEYS,
    filterKeys: ['minRating', 'maxRating', 'reportReason', 'submitted'],
  });
}

/**
 * The lists reviews registers with `lists` (`registerLists('reviews', ...)`): the seller's Reviews
 * list, guarded by its view key and never shared, and the admin moderation list, guarded by the
 * queue key, whose filters may be shared with the module's share key.
 */
export const REVIEWS_LISTS: readonly ListDefinition[] = [
  {
    listKey: SELLER_REVIEWS_LIST_KEY,
    population: 'seller',
    viewKey: REVIEWS_SELLER_VIEW.key,
    parsePayload: (raw) => parseSellerReviewFilterPayload(raw),
  },
  {
    listKey: MODERATION_LIST_KEY,
    population: 'admin',
    viewKey: REVIEWS_MODERATION_QUEUE.key,
    shareKey: REVIEWS_SAVED_FILTER_SHARE.key,
    parsePayload: (raw) => parseModerationFilterPayload(raw),
  },
];
