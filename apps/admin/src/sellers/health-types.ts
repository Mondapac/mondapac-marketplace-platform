// Answer of GET sellers/admin/:sellerId/health (apps/api seller-health.controller).
export const SELLER_VIEW_PERMISSION = 'sellers.seller.view';
export const HEALTH_RECALCULATE_PERMISSION = 'sellers.seller-health.recalculate';

export const HEALTH_METRICS = [
  'seller-cancellations',
  'late-ready',
  'customer-rating',
  'lost-disputes',
  'reports',
] as const;
export type HealthBand = 'healthy' | 'at-risk' | 'unhealthy';

export interface HealthMetricRow {
  readonly metric: string;
  readonly kind: 'scored' | 'no-data';
  readonly band?: HealthBand | null;
  readonly score?: number;
}

export interface HealthCardRead {
  readonly day: string;
  readonly kind: 'scored' | 'new' | 'no-data';
  readonly band: HealthBand | null;
  readonly score: number | null;
  readonly lowestMetric: string | null;
  readonly formulaVersion: string;
  readonly computedAt: string;
  readonly orders: number;
  readonly metrics: readonly HealthMetricRow[];
}

export interface HealthTrendPoint {
  readonly day: string;
  readonly kind: 'scored' | 'new' | 'no-data';
  readonly score: number | null;
}

export interface SellerHealthRead {
  readonly sellerId: string;
  readonly current: HealthCardRead | null;
  readonly trend: readonly HealthTrendPoint[];
}

export const healthPath = (sellerId: string): string => `sellers/admin/${sellerId}/health`;
export const recalculatePath = (sellerId: string): string =>
  `sellers/admin/${sellerId}/health/recalculate`;
