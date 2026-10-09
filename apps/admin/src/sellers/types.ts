// Answer of POST sellers/admin/list (apps/api seller-list.dto.ts). Clear fields only.

export const LIST_PERMISSION = 'sellers.seller.view';
export const TABS = ['awaiting-review', 'incomplete', 'all'] as const;
export type Tab = (typeof TABS)[number];
export const KINDS = ['onboarding', 'identity-change'] as const;

export const PAGE_SIZE = 25;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;

export interface SellerRow {
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly slug: string | null;
  readonly status: string | null;
  readonly origin: 'self' | 'invitation';
  readonly kind: string | null;
  readonly submittedAt: string | null;
  readonly serviceAreaCode: string | null;
  readonly timezone: string | null;
  readonly createdAt: string;
  readonly lastChangedAt: string;
}

export interface SellerListCounts {
  readonly awaitingReview: { readonly onboarding: number; readonly identityChange: number };
  readonly incomplete: number;
  readonly all: number;
}

export interface SellerListPage {
  readonly tab: Tab;
  readonly items: readonly SellerRow[];
  readonly next: string | null;
  readonly counts: SellerListCounts;
}

export const STATUSES = [
  'details-incomplete',
  'outside-service-area',
  'ready-to-submit',
  'awaiting-review',
  'changes-needed',
  'approved',
  'suspended',
  'file-check-needed',
  'hidden',
] as const;
