// Answer of POST sellers/admin/list (apps/api seller-list.dto.ts). Clear fields only.

export const LIST_PERMISSION = 'sellers.seller.view';
/** Tabs read from the seller files: search and filters work here. */
export const FILE_TABS = ['awaiting-review', 'incomplete', 'all'] as const;
/** Tabs paged through identity's state (slice 6b): shown only when `stateCounts` comes back. */
export const STATE_TABS = ['changes-needed', 'not-approved', 'approved', 'suspended'] as const;
export const TABS = [...FILE_TABS, ...STATE_TABS] as const;
export type Tab = (typeof TABS)[number];
export type StateTab = (typeof STATE_TABS)[number];
export const isStateTab = (tab: Tab): tab is StateTab =>
  (STATE_TABS as readonly string[]).includes(tab);
export const KINDS = ['onboarding', 'identity-change'] as const;

export const PAGE_SIZE = 25;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;

export interface SellerRow {
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly slug: string | null;
  readonly status: string | null;
  /** Personal data: escaped text only, never logged. Null when hidden or not known. */
  readonly owner: { readonly displayName: string | null; readonly email: string } | null;
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

export interface SellerListStateCounts {
  readonly changesNeeded: number;
  readonly notApproved: number;
  readonly approved: number;
  readonly suspended: number;
}

export interface SellerListPage {
  readonly tab: Tab;
  readonly items: readonly SellerRow[];
  readonly next: string | null;
  readonly counts: SellerListCounts;
  /** Null when the admin may not see identity's state: the state tabs are then not shown. */
  readonly stateCounts: SellerListStateCounts | null;
}

export const STATUSES = [
  'details-incomplete',
  'outside-service-area',
  'ready-to-submit',
  'awaiting-review',
  'changes-needed',
  'not-approved',
  'approved',
  'suspended',
  'file-check-needed',
  'hidden',
] as const;
