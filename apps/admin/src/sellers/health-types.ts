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

// Answer of GET sellers/admin/health-queue: unhealthy sellers, worst score first.
export interface HealthQueueItem {
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly slug: string | null;
  readonly day: string;
  readonly score: number;
  readonly lowestMetric: string;
}

export interface HealthQueueRead {
  readonly items: readonly HealthQueueItem[];
  readonly truncated: boolean;
}

export const HEALTH_QUEUE_PATH = 'sellers/admin/health-queue';

// The "Needs a look" super list: GET sellers/admin/health-queue/list and its export (list 16).
export const HEALTH_QUEUE_LIST_PATH = 'sellers/admin/health-queue/list';
export const HEALTH_QUEUE_EXPORT_PATH = 'sellers/admin/health-queue/export';

export const VIEWS = ['all', ...HEALTH_METRICS] as const;
export type View = (typeof VIEWS)[number];
export const SORTS = ['score', 'name', 'day'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
export const ROW_ACTIONS = ['open'] as const;

export interface HealthQueueRow extends HealthQueueItem {
  /** What this admin may do on the row; the API names it, the panel shows only what it knows. */
  readonly actions: readonly string[];
}

export type HealthViewCounts = Readonly<Record<View, number>>;

export interface HealthQueuePage {
  readonly items: readonly HealthQueueRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly paging: 'pages' | 'prev-next';
  /** Null with Previous and next (never counted). */
  readonly total: number | null;
  readonly hasNext: boolean;
  /** The count of each view among the sellers read, whatever the filter. */
  readonly counts: HealthViewCounts;
  /** More sellers were unhealthy than the queue holds (200). */
  readonly truncated: boolean;
}
