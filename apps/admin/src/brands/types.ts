// Answers of the admin brand routes (apps/api brand.dto.ts) and the limits of their fields. Text
// is what an admin or a seller typed: rendered as plain text only.

export const READ_PERMISSION = 'catalog.brand.read';
export const EDIT_PERMISSION = 'catalog.brand.edit';
export const BRANDS_PATH = '/catalog/brands';
export const API_BRANDS = 'catalog/admin/brands';
export const API_QUEUE = 'catalog/admin/brands/merge-queue';
export const PAGE_SIZE = 25;
export const SOURCE_PAGE_SIZE = 50;
export const NAME_MAX = 120;
export const SUMMARY_MAX = 1000;
export const ALT_MAX = 200;
export const ALIAS_MAX = 20;
export const MERGE_SOURCES_MAX = 10;

export type BrandStatus = 'draft' | 'active' | 'archived';

export interface BrandRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string | null;
  readonly originCountry: string | null;
  readonly logoImageId: string | null;
  readonly logoAlt: string | null;
  readonly headerImageId: string | null;
  readonly status: BrandStatus;
  readonly proposedBySellerId: string | null;
  readonly approvedBy: string | null;
  readonly mergedIntoId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface BrandPage {
  readonly items: readonly BrandRow[];
  readonly nextAfterId: string | null;
}

export interface BrandWrap {
  readonly brand: BrandRow;
}

export interface QueueBrand extends BrandRow {
  readonly productCount: number;
}

export interface QueueGroup {
  readonly groupKey: string;
  readonly brands: readonly QueueBrand[];
}

export interface QueueBody {
  readonly groups: readonly QueueGroup[];
}

export interface MergeBody {
  readonly brand: BrandRow;
  readonly merged: readonly { readonly brandId: string; readonly productsMoved: number }[];
  readonly aliasesAdded: readonly string[];
}

/** The tabs of the screen: three are lists of one status, one is the merge queue. */
export const TABS = ['active', 'draft', 'duplicates', 'archived'] as const;
export type Tab = (typeof TABS)[number];

export const STATUS_OF: Readonly<Record<Exclude<Tab, 'duplicates'>, BrandStatus>> = {
  active: 'active',
  draft: 'draft',
  archived: 'archived',
};
