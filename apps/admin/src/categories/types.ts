// Answers of the admin category read routes (apps/api category-admin.dto.ts) and the facts the
// page keeps about them. Names are text an admin entered: rendered as plain text only.

export const READ_PERMISSION = 'catalog.category-tree.view';
export const EDIT_PERMISSION = 'catalog.category-tree.edit';
export const CATEGORIES_PATH = '/catalog/categories';
export const API_CATEGORIES = 'catalog/admin/categories';

export type CategoryStatus = 'active' | 'merged' | 'archived';
export const STATUS_FILTERS = ['all', 'active', 'merged', 'archived'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface CategoryName {
  readonly locale: string;
  readonly name: string;
}

export interface CategoryCounts {
  /** Live products in the subtree (published, with a listed Offer). */
  readonly liveProducts: number;
  /** Live products that name this category itself. */
  readonly liveProductsDirect: number;
  /** Non-deleted Offers on the products of the subtree. */
  readonly offers: number;
}

export interface CategoryRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly status: CategoryStatus;
  readonly mergedIntoId: string | null;
  readonly names: readonly CategoryName[];
  /** 0 for a department. */
  readonly depth: number;
  readonly position: number;
  readonly version: number;
  readonly counts: CategoryCounts;
}

export interface ActionAnswer {
  readonly allowed: boolean;
  readonly denial?: string;
}

export interface TreeBody {
  readonly treeVersion: number;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly requiredLocales: readonly string[];
  /** False when the counts hit their time bound: they are then "at least". */
  readonly complete: boolean;
  /** Depth first, siblings in order. */
  readonly categories: readonly CategoryRow[];
  readonly actions: Readonly<Record<string, ActionAnswer>>;
}

export interface PathEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string | null;
}

export interface Revision {
  readonly revisionNo: number;
  readonly changeKind: string;
  readonly authorKind: 'seed' | 'admin';
  readonly authorAccountId: string | null;
  readonly parentId: string | null;
  readonly names: readonly CategoryName[];
  readonly createdAt: string;
}

export interface DetailBody {
  readonly category: CategoryRow;
  readonly path: readonly PathEntry[];
  readonly requiredLocales: readonly string[];
  readonly missingLocales: readonly string[];
  readonly revisions: readonly Revision[];
  readonly complete: boolean;
  readonly actions: Readonly<Record<string, ActionAnswer>>;
}

export const DETAIL_TABS = ['details', 'products', 'history'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

export interface ImpactBody {
  readonly products: number;
  readonly directProducts: number;
  readonly offers: number;
  readonly listedOffers: number;
  readonly offersWithActiveTag: number;
  readonly descendants: number;
  readonly complete: boolean;
}
