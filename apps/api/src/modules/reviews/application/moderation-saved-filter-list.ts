import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ListDefinition, ListPayloadFailure } from '../../lists';
import {
  REVIEWS_MODERATION_QUEUE,
  REVIEWS_MODERATION_SAVED_FILTER_SHARE,
} from '../contracts/permissions';
import {
  MODERATION_LIST_VIEWS,
  MODERATION_SORT_KEYS,
  type ModerationListView,
  type ModerationSortKey,
} from '../domain/moderation-list';
import { SELLER_REPORT_REASONS, type SellerReportReason } from '../domain/seller-reply';

// The saved filters of the admin review moderation list (super list phase 3, list 18; CLAUDE.md
// rule 14), through the generic routes of `lists`. This module keeps the meaning of a saved
// filter's document and the keys that guard the list; `lists` keeps the table, the caps, the names
// and the sharing rules. The document is closed: the view, the star range ("1" to "5", as the
// panel keeps them), the report reason (one a shop can report a review with), a date preset, the
// sort and its direction. The search text, a pasted id and the seller link are never saved, and no
// buyer is part of it.

export const MODERATION_LIST_KEY = 'admin.reviews.moderation';

/**
 * The date presets a saved filter may hold. The panel turns one into instants on its own clock when
 * it applies the filter, so a saved "Last 7 days" keeps meaning the last seven days. Same ids as
 * the panel's date presets.
 */
export const MODERATION_DATE_PRESETS = [
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
  'this-month',
  'last-month',
] as const;
export type ModerationDatePreset = (typeof MODERATION_DATE_PRESETS)[number];

const STARS = ['1', '2', '3', '4', '5'] as const;
type Stars = (typeof STARS)[number];

/** The closed document of a saved filter, in its canonical form (an unset part is left out). */
export interface ModerationFilterPayload {
  readonly v: 1;
  readonly view: ModerationListView;
  readonly filters?: {
    readonly minRating?: Stars;
    readonly maxRating?: Stars;
    readonly reportReason?: SellerReportReason;
    readonly submitted?: ModerationDatePreset;
  };
  readonly sort?: ModerationSortKey;
  readonly direction?: 'asc' | 'desc';
}

const TOP_KEYS = ['v', 'view', 'filters', 'sort', 'direction'] as const;
const FILTER_KEYS = ['minRating', 'maxRating', 'reportReason', 'submitted'] as const;

const invalid = (path: string, code: string): { ok: false; error: ListPayloadFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ListPayloadFailure;
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unset = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * Reads a saved filter's document and returns its canonical form, or the first field it refuses
 * (`payload.<path>`, `unknown`, `type` or `value`). A top star count below the lowest one is
 * refused, as the list does.
 */
export function parseModerationFilterPayload(
  raw: unknown,
): Result<ModerationFilterPayload, ListPayloadFailure> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw)) {
    if (!(TOP_KEYS as readonly string[]).includes(key)) return invalid(`payload.${key}`, 'unknown');
  }
  if (raw['v'] !== 1) return invalid('payload.v', 'value');
  const view = raw['view'];
  if (typeof view !== 'string') return invalid('payload.view', 'type');
  const knownView = MODERATION_LIST_VIEWS.find((candidate) => candidate === view);
  if (knownView === undefined) return invalid('payload.view', 'value');

  const filters: {
    minRating?: Stars;
    maxRating?: Stars;
    reportReason?: SellerReportReason;
    submitted?: ModerationDatePreset;
  } = {};
  const given = raw['filters'];
  if (!unset(given)) {
    if (!isRecord(given)) return invalid('payload.filters', 'type');
    for (const key of Object.keys(given)) {
      if (!(FILTER_KEYS as readonly string[]).includes(key)) {
        return invalid(`payload.filters.${key}`, 'unknown');
      }
    }
    for (const field of ['minRating', 'maxRating'] as const) {
      const stars = given[field];
      if (unset(stars)) continue;
      const known = STARS.find((candidate) => candidate === stars);
      if (known === undefined) return invalid(`payload.filters.${field}`, 'value');
      filters[field] = known;
    }
    if (
      filters.minRating !== undefined &&
      filters.maxRating !== undefined &&
      filters.maxRating < filters.minRating
    ) {
      return invalid('payload.filters.maxRating', 'value');
    }
    const reason = given['reportReason'];
    if (!unset(reason)) {
      const known = SELLER_REPORT_REASONS.find((candidate) => candidate === reason);
      if (known === undefined) return invalid('payload.filters.reportReason', 'value');
      filters.reportReason = known;
    }
    const preset = given['submitted'];
    if (!unset(preset)) {
      const known = MODERATION_DATE_PRESETS.find((candidate) => candidate === preset);
      if (known === undefined) return invalid('payload.filters.submitted', 'value');
      filters.submitted = known;
    }
  }

  const sort = raw['sort'];
  let knownSort: ModerationSortKey | undefined;
  if (!unset(sort)) {
    knownSort = MODERATION_SORT_KEYS.find((candidate) => candidate === sort);
    if (knownSort === undefined) return invalid('payload.sort', 'value');
  }
  const direction = raw['direction'];
  if (!unset(direction) && direction !== 'asc' && direction !== 'desc') {
    return invalid('payload.direction', 'value');
  }

  const ordered = Object.fromEntries(
    FILTER_KEYS.flatMap((key) => (filters[key] === undefined ? [] : [[key, filters[key]]])),
  ) as NonNullable<ModerationFilterPayload['filters']>;
  return ok({
    v: 1,
    view: knownView,
    ...(Object.keys(ordered).length === 0 ? {} : { filters: ordered }),
    ...(knownSort === undefined ? {} : { sort: knownSort }),
    ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
  });
}

/**
 * The list reviews registers for moderators: the moderation queue, guarded by the queue key;
 * sharing a filter with every moderator needs the module's own protected share key.
 */
export const REVIEWS_MODERATION_LISTS: readonly ListDefinition[] = [
  {
    listKey: MODERATION_LIST_KEY,
    population: 'admin',
    viewKey: REVIEWS_MODERATION_QUEUE.key,
    shareKey: REVIEWS_MODERATION_SAVED_FILTER_SHARE.key,
    parsePayload: (raw) => parseModerationFilterPayload(raw),
  },
];
