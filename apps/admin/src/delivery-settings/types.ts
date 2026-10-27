// Answers of the admin delivery-settings routes (apps/api delivery-settings.controller.ts).

export const DELIVERY_VIEW_PERMISSION = 'shipping.delivery-settings.view';
export const DELIVERY_MANAGE_PERMISSION = 'shipping.delivery-settings.manage';
export const DELIVERY_SETTINGS_PATH = 'shipping/admin/delivery-settings';

export const sellerMethodsPath = (sellerId: string): string =>
  `shipping/admin/sellers/${sellerId}/delivery-methods`;

export const METHODS = ['pickup', 'instant', 'same_day', 'scheduled'] as const;
export type Method = (typeof METHODS)[number];

export type MarginKind = 'none' | 'percent' | 'fixed';

export interface Margin {
  readonly kind: MarginKind;
  /** percent only: hundredths of a percent (1000 is 10 %). */
  readonly basisPoints?: number;
  /** fixed only: minor units of the Market currency. */
  readonly amountMinor?: number;
}

export interface DeliverySettings {
  readonly enabled: Readonly<Record<Method, boolean>>;
  /** HH:MM, local time. */
  readonly sameDayCutoff: string;
  readonly scheduledDaysAhead: number;
  readonly scheduledWindowMinutes: number;
  readonly margin: Margin;
  /** Round the total up to a multiple of this many minor units; 1 is no rounding. */
  readonly roundingStepMinor: number;
  /** Rises with each save; sent back as `expectedVersion`. 0 while the defaults apply. */
  readonly version: number;
  readonly currency: string;
  /** The Market's zone: the fallback for a seller without one. */
  readonly marketZone: string;
  readonly roundingSteps: readonly number[];
}

export interface SellerMethods {
  readonly sellerId: string;
  readonly supported: readonly Method[];
  /** What the Market has on. */
  readonly platformEnabled: Readonly<Record<Method, boolean>>;
}

export const MIN_DAYS = 1;
export const MAX_DAYS = 30;
/** The window lengths the page offers, in minutes (the API takes any multiple of 15 from 30 to 480). */
export const WINDOW_CHOICES = [30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480] as const;
