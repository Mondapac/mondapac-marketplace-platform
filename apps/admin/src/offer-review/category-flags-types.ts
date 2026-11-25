// The Offer review flags of platform categories (apps/api catalog offer-review-flags.controller.ts).

export const CATEGORY_FLAGS_PATH = 'catalog/admin/offer-review/category-flags';
export const CATEGORY_VIEW_PERMISSION = 'catalog.category-tree.view';
export const ALWAYS_REVIEW_PERMISSION = 'catalog.category-review.manage';
export const REVIEW_STOP_PERMISSION = 'catalog.offer-review-stop.manage';
export const OFFER_REVIEW_SETTINGS_HREF = '/settings/offer-review';
export const CATEGORY_FLAGS_HREF = '/settings/offer-review/categories';

export type CategoryFlagId = 'always-review' | 'review-stop';

export interface FlaggedCategory {
  readonly categoryId: string;
  readonly alwaysReview: boolean;
  readonly reviewStop: boolean;
  readonly alwaysReviewChangedAt: string | null;
  readonly reviewStopChangedAt: string | null;
  /** The expectedVersion of the next change of this category (0 for one not listed). */
  readonly version: number;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function flaggedCategoriesOf(body: unknown): readonly FlaggedCategory[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const rows: FlaggedCategory[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return null;
    const v = item as Record<string, unknown>;
    if (
      typeof v['categoryId'] !== 'string' ||
      typeof v['alwaysReview'] !== 'boolean' ||
      typeof v['reviewStop'] !== 'boolean' ||
      typeof v['version'] !== 'number'
    ) {
      return null;
    }
    rows.push({
      categoryId: v['categoryId'],
      alwaysReview: v['alwaysReview'],
      reviewStop: v['reviewStop'],
      alwaysReviewChangedAt: str(v['alwaysReviewChangedAt']),
      reviewStopChangedAt: str(v['reviewStopChangedAt']),
      version: v['version'],
    });
  }
  return rows;
}

/** A category to pick: its id and its path as words ("Food > Dates"). */
export interface CategoryChoice {
  readonly id: string;
  readonly label: string;
}

export const categoryFlagPath = (categoryId: string, flag: CategoryFlagId): string =>
  `catalog/admin/categories/${categoryId}/${flag === 'always-review' ? 'offer-review' : 'offer-review-stop'}`;
