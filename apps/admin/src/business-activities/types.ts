// Answers of the admin business-activity routes (apps/api business-activity.dto.ts) and the
// limits of their fields. Text is what an admin typed: rendered as plain text only.

export const READ_PERMISSION = 'catalog.business-activity.read';
export const EDIT_PERMISSION = 'catalog.business-activity.edit';
export const ACTIVITIES_PATH = '/catalog/business-activities';
export const API_ACTIVITIES = 'catalog/admin/business-activities';
export const API_CATEGORIES = 'catalog/categories';
export const PAGE_SIZE = 25;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 300;
export const CODE_MAX = 40;
export const CATEGORIES_MAX = 100;
/** Activities reach level 1 and level 2 of the category tree (depth 0 and 1). */
export const CATEGORY_MAX_DEPTH = 1;

export type ActivityStatus = 'active' | 'inactive';
export const STATUS_FILTERS = ['active', 'inactive'] as const;
export type StatusFilter = 'all' | ActivityStatus;

export interface ActivityRow {
  readonly id: string;
  readonly code: string;
  readonly status: ActivityStatus;
  /** The name by locale; the Market default locale is always present. */
  readonly names: Readonly<Record<string, string>>;
  readonly description: string | null;
  readonly categoryIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface Locales {
  readonly default: string;
  readonly supported: readonly string[];
}

export interface ActivityPage {
  readonly items: readonly ActivityRow[];
  readonly nextAfterId: string | null;
  readonly locales: Locales;
}

export interface ActivityWrap {
  readonly activity: ActivityRow;
}

/** GET catalog/categories: the public tree, depth first. */
export interface CategoryTree {
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
    readonly depth: number;
  }[];
}
