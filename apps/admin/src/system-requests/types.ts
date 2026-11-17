// System requests (apps/api system-requests presentation): the answers of the admin routes, the
// queue's query and the small rules the screens share. Every instant is an ISO 8601 string in UTC;
// people are account ids, with an optional name when the API sends one.

import type { ListPaging } from '../orders/orders-query.ts';
import { startOfDay } from '../sales/day-start.ts';

export type { ListPaging };

export const VIEW_PERMISSION = 'system-requests.request.view';
export const POLICY_VIEW_PERMISSION = 'system-requests.policy.view';
export const POLICY_MANAGE_PERMISSION = 'system-requests.policy.manage';

/** The step-up action keys of the decisions and policy changes (apps/api, notes.md). */
export const DECIDE_HIGH_KEY = 'system-requests.request.decide-high';
export const POLICY_CHANGE_KEY = 'system-requests.policy.change';

export const BASE = 'system-requests/admin';

/** Where an admin sets up two-step verification. */
export const PROFILE_PATH = '/account/profile';
export const QUEUE_PATH = '/system-requests';

/** A page or a view count that is at the API's cap reads "10,000+". */
export const COUNT_CAP = 10_000;
/** Page numbers stop at this row (the API's cap); the same number caps every view count. */
export const MAX_PAGED_ROWS = 10_000;

export const VIEWS = [
  'needs-my-review',
  'all-open',
  'mine',
  'approved',
  'reverted',
  'overdue',
  'all',
] as const;
export type View = (typeof VIEWS)[number];

/** The areas a request can belong to, in the order the filter lists them. */
export const AREAS = [
  'people',
  'money',
  'delivery',
  'catalogue',
  'certification',
  'marketplace',
  'content',
  'review-policy',
] as const;
export type Area = (typeof AREAS)[number];
/** The areas the policy page can switch (the review policy itself is always reviewed). */
export const POLICY_AREAS = AREAS.filter((area) => area !== 'review-policy') as readonly Exclude<
  Area,
  'review-policy'
>[];

export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];
export const STATUSES = ['open', 'approved', 'reverted'] as const;
export type Status = (typeof STATUSES)[number];
export type Decision = 'approved' | 'rejected' | 'withdrawn';
export type RowAction = 'open' | 'copy-link' | 'approve' | 'reject' | 'withdraw';

export const SORTS = ['applied', 'due', 'number'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';

/** The natural first direction of a sort: newest and most urgent first, numbers newest first. */
export const defaultDirection = (sort: Sort): Direction => (sort === 'due' ? 'asc' : 'desc');

export const SEARCH_MAX = 100;
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
export const NOTE_MAX = 500;
export const COMMENT_MAX = 2000;
/** The most ids one bulk approve takes (the API's cap). */
export const BULK_MAX_IDS = 100;

export interface SystemRequest {
  readonly id: string;
  readonly number: number;
  readonly displayNumber: string;
  readonly area: Area;
  readonly subjectKind: string;
  readonly subjectRef: string;
  /** A human name of the subject, when the API sends one. */
  readonly subjectLabel?: string | null;
  readonly risk: Risk;
  readonly status: Status;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly note: string;
  readonly requestedBy: string;
  readonly requestedByName?: string | null;
  readonly appliedAt: string;
  readonly reviewDueAt: string;
  readonly overdue: boolean;
  readonly decision: Decision | null;
  readonly decidedBy: string | null;
  readonly decidedByName?: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly supersededBy: string | null;
  /** The number of the later request, when the API sends it. */
  readonly supersededByNumber?: number | null;
  readonly commentCount: number;
  readonly reviewPermission: string;
  readonly actions: readonly RowAction[];
}

export interface ActivityLine {
  readonly id: string;
  readonly kind: string;
  readonly actor: string;
  readonly actorName?: string | null;
  readonly at: string;
  readonly body: string | null;
}

export interface SystemRequestDetail extends SystemRequest {
  readonly activity: readonly ActivityLine[];
}

export type Counts = Readonly<Record<View, number>>;

export interface RequestPage {
  readonly rows: readonly SystemRequest[];
  readonly counts: Counts;
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
}

export interface Badge {
  readonly needsMyReview: number;
  readonly overdue: number;
}

export interface BulkAnswer {
  readonly results: readonly { readonly requestId: string; readonly outcome: string }[];
}

export interface BulkMatchingAnswer {
  readonly approved: readonly {
    readonly id: string;
    readonly number: number;
    readonly displayNumber: string;
  }[];
  readonly failed: readonly { readonly id: string; readonly code: string }[];
  /** How many matching requests are left; null when counting failed after approvals committed. */
  readonly remaining: number | null;
}

export interface RecordedRequest {
  readonly id: string;
  readonly number: number;
  readonly displayNumber: string;
}

export interface AreaPolicy {
  readonly area: Exclude<Area, 'review-policy'>;
  readonly enabled: boolean;
  readonly risk: Risk;
  readonly reviewPermission: string;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly updatedByName?: string | null;
}

export interface DueDays {
  readonly reviewDueDays: number;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly updatedByName?: string | null;
}

export interface ReviewPolicy {
  readonly areas: readonly AreaPolicy[];
  readonly reviewDueDays: DueDays;
  readonly reviewPolicy: { readonly risk: 'high'; readonly reviewPermission: string };
}

export interface PolicyChange<T> {
  readonly value: T;
  readonly request: RecordedRequest | null;
}

// --- The queue's query ---------------------------------------------------------------------

export interface Filters {
  readonly area: readonly string[];
  readonly risk: readonly string[];
  readonly status: readonly string[];
  /** Calendar days (yyyy-mm-dd) on the admin's clock; '' leaves the end open. */
  readonly from: string;
  readonly to: string;
  readonly overdue: boolean;
  /** Set only by a deep link ("setting page banner"); shown as a read-only chip. */
  readonly subjectKind: string;
  readonly subjectRef: string;
}

export const NO_FILTERS: Filters = {
  area: [],
  risk: [],
  status: [],
  from: '',
  to: '',
  overdue: false,
  subjectKind: '',
  subjectRef: '',
};

export interface Query {
  readonly view: View;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'needs-my-review',
  q: '',
  filters: NO_FILTERS,
  sort: 'applied',
  direction: 'desc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

/** Views that fix the status: the Status filter would contradict them and is hidden. */
export const STATUS_BOUND_VIEWS: readonly View[] = ['approved', 'reverted'];

/** The number of filter values set (a chip each), the subject deep link included. */
export function filterCount(filters: Filters): number {
  return (
    filters.area.length +
    filters.risk.length +
    filters.status.length +
    (filters.from === '' ? 0 : 1) +
    (filters.to === '' ? 0 : 1) +
    (filters.overdue ? 1 : 0) +
    (filters.subjectKind === '' ? 0 : 1)
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True when both days are set and the end is before the start: the filter matches nothing. */
export const rangeIsBackwards = (filters: Filters): boolean =>
  DAY.test(filters.from) && DAY.test(filters.to) && filters.to < filters.from;

/**
 * The filter part of the list query, shared by the list and by "approve all matching". `zone` is
 * the admin's IANA zone: the days are read on its clock, and the last day is included (the API's
 * end is the first instant after it).
 */
export function filterParams(query: Query, zone: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set('view', query.view);
  if (query.q !== '') params.set('q', query.q);
  const { filters } = query;
  const bound = STATUS_BOUND_VIEWS.includes(query.view);
  if (filters.area.length > 0) params.set('area', filters.area.join(','));
  if (filters.risk.length > 0) params.set('risk', filters.risk.join(','));
  if (filters.status.length > 0 && !bound) params.set('status', filters.status.join(','));
  const from = startOfDay(filters.from, zone);
  const to = startOfDay(filters.to, zone, 1);
  if (from !== null) params.set('appliedFrom', from);
  if (to !== null) params.set('appliedTo', to);
  if (filters.overdue && query.view !== 'overdue') params.set('overdue', 'true');
  if (filters.subjectKind !== '') params.set('subjectKind', filters.subjectKind);
  if (filters.subjectRef !== '') params.set('subjectRef', filters.subjectRef);
  return params;
}

/** The list route's query string: filters, sort, and page numbers or a cursor. */
export function queryString(
  query: Query,
  zone: string,
  mode: ListPaging,
  cursor: string | null,
): string {
  const params = filterParams(query, zone);
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  params.set('pageSize', String(query.pageSize));
  if (mode === 'pages') params.set('page', String(query.page));
  else if (cursor !== null) params.set('cursor', cursor);
  return params.toString();
}

/**
 * The body of "approve all matching": the list's own filter keys and values, so the API reads it
 * with the list's parser. No sort and no paging: the API walks the filter itself.
 */
export function matchingBody(query: Query, zone: string): Record<string, string> {
  return Object.fromEntries(filterParams(query, zone));
}

export const isView = (value: string | null): value is View => VIEWS.some((view) => view === value);
const isSort = (value: string | null): value is Sort => SORTS.some((sort) => sort === value);

const listOf = (value: string | null, allowed: readonly string[]): readonly string[] =>
  (value ?? '')
    .split(',')
    .filter((entry, index, all) => allowed.includes(entry) && all.indexOf(entry) === index);

/** The query a page address names (a deep link, or the address the queue wrote); unknown parts are dropped. */
export function queryFromSearch(search: string, fallbackView: View = DEFAULT_QUERY.view): Query {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  const sort = params.get('sort');
  const chosen = isSort(sort) ? sort : DEFAULT_QUERY.sort;
  const direction = params.get('direction');
  const kind = params.get('subjectKind') ?? '';
  const subjectOk = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(kind);
  const ref = params.get('subjectRef') ?? '';
  const day = (value: string | null) => (value !== null && DAY.test(value) ? value : '');
  const size = Number(params.get('pageSize'));
  return {
    view: isView(view) ? view : fallbackView,
    q: (params.get('q') ?? '').slice(0, SEARCH_MAX),
    filters: {
      area: listOf(params.get('area'), AREAS),
      risk: listOf(params.get('risk'), RISKS),
      status: listOf(params.get('status'), STATUSES),
      from: day(params.get('from')),
      to: day(params.get('to')),
      overdue: params.get('overdue') === 'true',
      subjectKind: subjectOk ? kind : '',
      subjectRef: subjectOk && /^[A-Za-z0-9._:-]{1,64}$/.test(ref) ? ref : '',
    },
    sort: chosen,
    direction: direction === 'asc' || direction === 'desc' ? direction : defaultDirection(chosen),
    page: 1,
    pageSize: PAGE_SIZES.some((allowed) => allowed === size) ? size : DEFAULT_PAGE_SIZE,
  };
}

/** The address the queue shows for a query: only what differs from the defaults. */
export function searchOf(query: Query): string {
  const params = new URLSearchParams();
  params.set('view', query.view);
  if (query.q !== '') params.set('q', query.q);
  const { filters } = query;
  if (filters.area.length > 0) params.set('area', filters.area.join(','));
  if (filters.risk.length > 0) params.set('risk', filters.risk.join(','));
  if (filters.status.length > 0) params.set('status', filters.status.join(','));
  if (filters.from !== '') params.set('from', filters.from);
  if (filters.to !== '') params.set('to', filters.to);
  if (filters.overdue) params.set('overdue', 'true');
  if (filters.subjectKind !== '') params.set('subjectKind', filters.subjectKind);
  if (filters.subjectRef !== '') params.set('subjectRef', filters.subjectRef);
  if (query.sort !== DEFAULT_QUERY.sort) params.set('sort', query.sort);
  if (query.direction !== defaultDirection(query.sort)) params.set('direction', query.direction);
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(query.pageSize));
  return params.toString();
}

// --- Display rules ---------------------------------------------------------------------------

/** A view count as text: "10,000+" at the cap. */
export function countText(count: number, format: (value: number) => string): string {
  return count >= COUNT_CAP ? `${format(COUNT_CAP)}+` : format(count);
}

export const OPTIONAL_COLUMNS = [
  'subject',
  'requestedBy',
  'applied',
  'due',
  'decidedBy',
  'decided',
  'comments',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [
  'subject',
  'requestedBy',
  'applied',
  'due',
];

const isColumn = (id: unknown): id is OptionalColumn =>
  OPTIONAL_COLUMNS.some((column) => column === id);

/** The columns a stored choice names, in its order; nothing stored means the defaults. */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly OptionalColumn[] {
  if (saved === undefined) return DEFAULT_COLUMNS;
  return [...new Set(saved.filter(isColumn))];
}

export const has = (row: Pick<SystemRequest, 'actions'>, action: RowAction): boolean =>
  row.actions.includes(action);

/** Whole days an open request is past its review date, on the admin's clock; 0 when not late. */
export function daysOverdue(reviewDueAt: string, now: Date, zone: string): number {
  const due = new Date(reviewDueAt);
  if (Number.isNaN(due.getTime()) || due >= now) return 0;
  const dayOf = (date: Date) => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: zone, numberingSystem: 'latn' }).format(
        date,
      );
    } catch {
      return date.toISOString().slice(0, 10);
    }
  };
  const a = Date.parse(`${dayOf(due)}T00:00:00Z`);
  const b = Date.parse(`${dayOf(now)}T00:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

/** The kind's own words when it is not in the catalogue: "wallet.market-status" -> "Market status". */
export function humanKind(kind: string): string {
  const part = kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : kind;
  const words = part.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The message key of a subject kind's title ("commission-payouts.commission-rate" -> "commission-payouts--commission-rate"). */
export const kindKey = (kind: string): string => kind.replace('.', '--');

/** The page of a subject, when the panel knows one. */
export function subjectHref(kind: string, ref: string): string | null {
  switch (kind) {
    case 'commission-payouts.commission-rate':
    case 'commission-payouts.payout-terms':
      return /^[0-9a-f-]{36}$/i.test(ref) ? `/sellers/${ref}` : null;
    case 'wallet.market-status':
      return '/settings/wallet';
    case 'system-requests.policy-area':
    case 'system-requests.review-due-days':
      return '/settings/review-policy';
    default:
      return null;
  }
}

/** The path of a request's page. */
export const requestPath = (id: string): string => `${QUEUE_PATH}/${id}`;

/** The short reference shown while an id has no number: the end of the id. */
export const shortRef = (id: string): string => id.slice(-8).toUpperCase();
