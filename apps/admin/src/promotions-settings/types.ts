// Answers of the admin promotions settings routes (apps/api promotions.controller.ts, the
// `promotions/admin` settings, first-order and free-shipping routes). Amounts are digit strings
// of minor units in the Market's currency; a percentage is in basis points (10000 is 100 %).

/** Reads and changes the Market switch. Protected: the Platform Administrator holds it. */
export const PROMOTIONS_SETTINGS_VIEW = 'promotions.settings.view';
export const PROMOTIONS_SETTINGS_MANAGE = 'promotions.settings.manage';
/** Reads and changes the first-order discount and the free-delivery thresholds. */
export const PROMOTIONS_MANAGE = 'promotions.promotion.manage';

export const SWITCH_PATH = 'promotions/admin/settings';
export const FIRST_ORDER_PATH = 'promotions/admin/first-order';
export const THRESHOLDS_PATH = 'promotions/admin/free-shipping';
export const thresholdPath = (zoneCode: string): string =>
  `${THRESHOLDS_PATH}/${encodeURIComponent(zoneCode)}`;

export type MarketStatus = 'off' | 'active';

export interface MarketSwitch {
  readonly status: MarketStatus;
  /** ISO instant of the last change; null while it was never switched. */
  readonly updatedAt: string | null;
}

export type DiscountKind = 'PERCENT' | 'FIXED';

export interface FirstOrderSettings {
  readonly enabled: boolean;
  readonly kind: DiscountKind;
  readonly percentBps: number | null;
  readonly amountMinor: string | null;
  readonly capMinor: string | null;
  readonly minSpendMinor: string;
  readonly monthlyBudgetMinor: string;
}

export interface FirstOrderView {
  /** Null when nothing is stored and the Market file has no default. */
  readonly settings: FirstOrderSettings | null;
  readonly source: 'stored' | 'config' | 'none';
  readonly currency: string;
}

export interface ZoneThreshold {
  readonly zoneCode: string;
  readonly thresholdMinor: string;
}

export interface Thresholds {
  readonly currency: string;
  readonly defaultThresholdMinor: string;
  /** Only the zones with a threshold of their own. */
  readonly zones: readonly ZoneThreshold[];
}
