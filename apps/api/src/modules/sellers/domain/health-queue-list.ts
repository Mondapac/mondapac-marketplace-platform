import { SELLER_HEALTH_METRICS, type SellerHealthMetric } from './seller-health';

// The admin "Needs a look" queue as a super list (phase 3, list 16; CLAUDE.md rule 14): the
// sellers whose newest stored health is unhealthy, with filters, sort, page numbers or
// Previous/Next, the row Actions menu and the export. The queue is bounded (at most 200 sellers,
// then `truncated`), so the filter, sort and page run over one read. Health only informs: nothing
// in the list acts on a seller. Pure rules; no I/O.

export const HEALTH_QUEUE_VIEWS = ['all', ...SELLER_HEALTH_METRICS] as const;
export type HealthQueueView = (typeof HEALTH_QUEUE_VIEWS)[number];

export const HEALTH_QUEUE_SORT_KEYS = ['score', 'name', 'day'] as const;
export type HealthQueueSortKey = (typeof HEALTH_QUEUE_SORT_KEYS)[number];

export interface HealthQueueSort {
  readonly key: HealthQueueSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. */
export interface HealthQueueFilter {
  readonly metric: SellerHealthMetric | null;
  readonly sellerId: string | null;
  /** A prefix of the store name or of the slug, lower-cased. */
  readonly prefix: string | null;
  /** The score, both ends included. */
  readonly minScore: number | null;
  readonly maxScore: number | null;
}

export const EMPTY_HEALTH_QUEUE_FILTER: HealthQueueFilter = Object.freeze({
  metric: null,
  sellerId: null,
  prefix: null,
  minScore: null,
  maxScore: null,
});

export const HEALTH_QUEUE_ROW_ACTIONS = ['open'] as const;
export type HealthQueueRowAction = (typeof HEALTH_QUEUE_ROW_ACTIONS)[number];

/** The columns an export may add, in the order the panel's column picker lists them. */
export const HEALTH_QUEUE_EXPORT_COLUMNS = ['seller-id', 'day'] as const;
export type HealthQueueExportColumn = (typeof HEALTH_QUEUE_EXPORT_COLUMNS)[number];

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;

/** What the filter and the sort read of one queue row. */
export interface HealthQueueSubject {
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly slug: string | null;
  readonly day: string;
  readonly score: number;
  readonly lowestMetric: SellerHealthMetric;
}

export function healthQueueMatches(row: HealthQueueSubject, filter: HealthQueueFilter): boolean {
  if (filter.metric !== null && row.lowestMetric !== filter.metric) return false;
  if (filter.sellerId !== null && row.sellerId !== filter.sellerId) return false;
  if (filter.prefix !== null) {
    const name = row.storeName?.toLowerCase() ?? '';
    const slug = row.slug?.toLowerCase() ?? '';
    if (!name.startsWith(filter.prefix) && !slug.startsWith(filter.prefix)) return false;
  }
  if (filter.minScore !== null && row.score < filter.minScore) return false;
  if (filter.maxScore !== null && row.score > filter.maxScore) return false;
  return true;
}

/** Sorts two rows; the seller id breaks every tie, so a page boundary never repeats a row. */
export function compareHealthQueue(
  a: HealthQueueSubject,
  b: HealthQueueSubject,
  sort: HealthQueueSort,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  let primary: number;
  if (sort.key === 'score') primary = a.score - b.score;
  else if (sort.key === 'day') primary = a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
  else {
    const left = (a.storeName ?? '').toLowerCase();
    const right = (b.storeName ?? '').toLowerCase();
    primary = left < right ? -1 : left > right ? 1 : 0;
  }
  if (primary !== 0) return sign * primary;
  return sign * (a.sellerId < b.sellerId ? -1 : a.sellerId > b.sellerId ? 1 : 0);
}
