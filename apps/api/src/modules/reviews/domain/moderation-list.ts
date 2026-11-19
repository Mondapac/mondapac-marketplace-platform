import type { Id, Temporal } from '@mondapac/shared-kernel';
import { statusAfter, type ModeratorAction } from './moderation';
import type { ReviewStatus } from './rules';

// The admin review moderation list as a super list (phase 3, list 18; CLAUDE.md rule 14): the
// held, reported and actioned reviews of the Market with views, filters, sort, page numbers or
// Previous/Next, the view counts, the row Actions menu and the export. It only reads. Moderating
// runs through its own use cases, each behind the admin's two-step proof, so there is no bulk
// action here. The author is never in a row: the moderator judges the content.

/** The views (tabs): the three queue tabs and every review that is in any of them. */
export const MODERATION_LIST_VIEWS = ['all', 'held', 'reported', 'actioned'] as const;
export type ModerationListView = (typeof MODERATION_LIST_VIEWS)[number];

export const MODERATION_SORT_KEYS = ['submitted', 'rating'] as const;
export type ModerationSortKey = (typeof MODERATION_SORT_KEYS)[number];

export interface ModerationSort {
  readonly key: ModerationSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. */
export interface ModerationFilter {
  readonly view: ModerationListView;
  readonly minRating: number | null;
  readonly maxRating: number | null;
  readonly sellerId: Id<'Seller'> | null;
  /** The reason code of at least one open report. */
  readonly reportReason: string | null;
  /** Plain text matched inside the title or the body, case-insensitive. */
  readonly text: string | null;
  /** An id the moderator pasted: the review's, its Offer's or its product's, exact. */
  readonly anyId: string | null;
  /** Submitted at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

export const EMPTY_MODERATION_FILTER: ModerationFilter = Object.freeze({
  view: 'all',
  minRating: null,
  maxRating: null,
  sellerId: null,
  reportReason: null,
  text: null,
  anyId: null,
  from: null,
  to: null,
});

/** The count of each view for the Market, whatever the filter. */
export type ModerationViewCounts = Readonly<Record<ModerationListView, number>>;

export const MODERATION_ROW_ACTIONS = [
  'open',
  'publish',
  'hide',
  'restore',
  'dismiss-reports',
  'remove',
] as const;
export type ModerationRowAction = (typeof MODERATION_ROW_ACTIONS)[number];

/** The columns an export may add, in the order the panel's column picker lists them. */
export const MODERATION_EXPORT_COLUMNS = [
  'review-id',
  'product-id',
  'offer-id',
  'seller-id',
  'locale',
  'edited',
  'signals',
] as const;
export type ModerationExportColumn = (typeof MODERATION_EXPORT_COLUMNS)[number];

/** The minimum of what {@link moderationMatches} reads of a review and its open reports. */
export interface ModerationSubject {
  readonly id: Id<'ProductReview'>;
  readonly productId: Id<'Product'>;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly status: ReviewStatus;
  readonly createdAt: Temporal.Instant;
  /** The reason codes of the open reports, one entry per report. */
  readonly openReportReasons: readonly string[];
}

const inTab = (view: Exclude<ModerationListView, 'all'>, s: ModerationSubject): boolean => {
  switch (view) {
    case 'held':
      return s.status === 'held';
    case 'actioned':
      return s.status === 'hidden' || s.status === 'removed';
    case 'reported':
      return ['published', 'held', 'hidden'].includes(s.status) && s.openReportReasons.length > 0;
  }
};

/** Whether a review is in a view (`all` is the union of the three tabs). */
export function inModerationView(view: ModerationListView, s: ModerationSubject): boolean {
  if (view === 'all') return inTab('held', s) || inTab('actioned', s) || inTab('reported', s);
  return inTab(view, s);
}

/** Whether a review meets a filter; the in-memory twin of the repository's `where`. */
export function moderationMatches(s: ModerationSubject, filter: ModerationFilter): boolean {
  if (!inModerationView(filter.view, s)) return false;
  if (filter.minRating !== null && s.rating < filter.minRating) return false;
  if (filter.maxRating !== null && s.rating > filter.maxRating) return false;
  if (filter.sellerId !== null && s.sellerId !== filter.sellerId) return false;
  if (filter.reportReason !== null && !s.openReportReasons.includes(filter.reportReason)) {
    return false;
  }
  if (filter.text !== null) {
    const hay = `${s.title ?? ''}\n${s.body ?? ''}`.toLowerCase();
    if (!hay.includes(filter.text.toLowerCase())) return false;
  }
  if (
    filter.anyId !== null &&
    s.id !== filter.anyId &&
    s.offerId !== filter.anyId &&
    s.productId !== filter.anyId
  ) {
    return false;
  }
  const at = s.createdAt.epochMilliseconds;
  if (filter.from !== null && at < filter.from.epochMilliseconds) return false;
  if (filter.to !== null && at >= filter.to.epochMilliseconds) return false;
  return true;
}

/** Sorts two reviews; the review id breaks every tie, so a page boundary never repeats a row. */
export function compareModeration(
  a: ModerationSubject,
  b: ModerationSubject,
  sort: ModerationSort,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const primary =
    sort.key === 'submitted'
      ? a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds
      : a.rating - b.rating;
  if (primary !== 0) return sign * primary;
  return sign * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The status-moving actions a review's status allows (the web shows these and no others). */
export function moderationActionsFor(
  status: ReviewStatus,
  openReports: number,
): readonly ModeratorAction[] {
  const actions: ModeratorAction[] = [];
  for (const action of ['publish', 'hide', 'restore', 'remove'] as const) {
    if (statusAfter(action, status) !== null) actions.push(action);
  }
  if (['published', 'held', 'hidden'].includes(status) && openReports > 0) {
    actions.push('dismiss-reports');
  }
  return actions;
}
