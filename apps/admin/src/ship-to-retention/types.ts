// Answer of the admin routes for the ship-to retention setting (apps/api ordering
// admin-ship-to-retention.controller.ts). Reading needs `ordering.ship-to-retention.view`; the
// change needs the protected `ordering.ship-to-retention.manage` (step-up action
// `ordering.ship-to-retention.change`).

export const SHIP_TO_RETENTION_VIEW_PERMISSION = 'ordering.ship-to-retention.view';
export const SHIP_TO_RETENTION_MANAGE_PERMISSION = 'ordering.ship-to-retention.manage';
export const SHIP_TO_RETENTION_PATH = 'ordering/admin/ship-to-retention';
export const MIN_MONTHS = 1;
export const MAX_MONTHS = 120;
export const DEFAULT_MONTHS = 24;

export interface ShipToRetention {
  readonly enabled: boolean;
  readonly months: number;
  /** 0 when never set. */
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}
