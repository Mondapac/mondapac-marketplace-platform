// Answers of the buyer assistant insights route (apps/api admin-assistant-insights.controller.ts)
// and the closed vocabulary of the unanswered-questions list.

export const INSIGHTS_PATH = 'assistant/admin/insights';
export const INSIGHTS_VIEW_PERMISSION = 'assistant.settings.view';
/** Largest page the route serves; the route keeps 200 groups, so two pages hold them all. */
export const INSIGHTS_PAGE_SIZE = 100;

export const REASONS = ['unavailable', 'tool-failed', 'no-results', 'thumbs-down'] as const;
export type Reason = (typeof REASONS)[number];

export interface InsightsDay {
  /** A day of the Market's calendar, YYYY-MM-DD. */
  readonly day: string;
  readonly conversations: number;
  /** Micro US dollars (1e-6 USD). */
  readonly spendMicroUsd: number;
}

export interface InsightsFeedback {
  readonly up: number;
  readonly down: number;
  /** 0 to 1; null with no thumbs. */
  readonly upShare: number | null;
  readonly reasons: Readonly<Record<string, number>>;
}

/** One group of unanswered turns. `query` is masked buyer text: always rendered as plain text. */
export interface UnansweredRow {
  readonly query: string;
  readonly count: number;
  /** ISO 8601 instant. */
  readonly lastAt: string;
  readonly reasons: Readonly<Partial<Record<Reason, number>>>;
}

export interface Insights {
  readonly from: string;
  readonly to: string;
  readonly days: readonly InsightsDay[];
  readonly totals: { readonly conversations: number; readonly spendMicroUsd: number };
  readonly feedback: InsightsFeedback;
  readonly handoffs: number;
  readonly unanswered: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly truncated: boolean;
    readonly rows: readonly UnansweredRow[];
  };
}

/** The days of the range the page asks for: the route allows 92 at most. */
export const RANGES = ['7', '30', '92'] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = '30';

export const VIEWS = ['all', 'thumbs-down', 'no-results', 'failed'] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['count', 'last', 'query'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';

export const FILTER_FIELDS = ['reason', 'minCount'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];
export type Filters = Readonly<Partial<Record<FilterField, string>>>;

export const MIN_COUNTS = ['2', '5', '10'] as const;

export interface Query {
  readonly view: View;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
}

export const PAGE_SIZE = 25;
export const SEARCH_MAX = 100;
export const SELECTION_MAX = 200;

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sort: 'count',
  direction: 'desc',
  page: 1,
};

export function defaultDirection(sort: Sort): Direction {
  return sort === 'query' ? 'asc' : 'desc';
}

export function filterCount(filters: Filters): number {
  return FILTER_FIELDS.filter((field) => filters[field] !== undefined).length;
}

export function filtersOf(source: Readonly<Record<string, string>>): Filters {
  const next: Partial<Record<FilterField, string>> = {};
  const reason = source.reason;
  if (reason !== undefined && (REASONS as readonly string[]).includes(reason)) {
    next.reason = reason;
  }
  const min = source.minCount;
  if (min !== undefined && (MIN_COUNTS as readonly string[]).includes(min)) next.minCount = min;
  return next;
}
