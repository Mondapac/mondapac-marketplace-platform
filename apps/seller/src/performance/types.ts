// Answer of GET sellers/own-health (apps/api own-seller-health.controller). Clear numbers only.

export const HEALTH_METRICS = [
  'seller-cancellations',
  'late-ready',
  'customer-rating',
  'lost-disputes',
  'reports',
] as const;
export type HealthMetric = (typeof HEALTH_METRICS)[number];
export type HealthBand = 'healthy' | 'at-risk' | 'unhealthy';

export interface HealthMetricRow {
  readonly metric: string;
  readonly kind: 'scored' | 'no-data';
  readonly band?: HealthBand | null;
  readonly score?: number;
}

export interface HealthCard {
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

export interface OwnHealth {
  readonly current: HealthCard | null;
  readonly trend: readonly HealthTrendPoint[];
  readonly refresh: { readonly pending: boolean; readonly retryAfterSeconds: number };
}

export const HEALTH_PATH = 'sellers/own-health';
export const REFRESH_PATH = 'sellers/own-health/refresh';
