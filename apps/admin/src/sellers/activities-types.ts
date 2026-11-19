// Answers of the admin seller business-activity routes (apps/api seller-activities.controller.ts).

export const ACTIVITIES_VIEW_PERMISSION = 'sellers.business-activity.view';
export const ACTIVITIES_MANAGE_PERMISSION = 'sellers.business-activity.manage';
/** The catalog list names the activities; without it a card shows ids as "unknown". */
export const CATALOG_ACTIVITY_READ_PERMISSION = 'catalog.business-activity.read';
export const REASON_MAX = 300;
export const EXTRA_MAX = 9;

export interface SellerActivities {
  readonly mainActivityId: string | null;
  readonly extraActivityIds: readonly string[];
  readonly lastChange: {
    readonly changedBy: string;
    readonly changedAt: string;
    readonly reason: string;
  } | null;
}

export interface SellerActivitiesChange {
  readonly mainActivityId: string;
  readonly extraActivityIds: readonly string[];
  readonly changed: boolean;
}

/** One activity of the Market, as the picker and the read view need it. */
export interface ActivityOption {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
}

export const sellerActivitiesPath = (sellerId: string): string =>
  `sellers/admin/${sellerId}/business-activities`;
