// The admin "Suspicious attributions" super list (customers management phase 4a): customers who
// joined a seller through its invite link. The API's answers, the page's query and the
// conversions between the query, the request body and a saved filter. Routes are under
// `customers/admin/seller-attributions/`; the list key for saved filters is below.

export const ATTRIBUTIONS_VIEW_PERMISSION = 'customers.customers.view';
export const ATTRIBUTIONS_MANAGE_PERMISSION = 'customers.seller-attributions.manage';
export const ATTRIBUTIONS_EXPORT_PERMISSION = 'customers.customers.export';
export const ATTRIBUTIONS_SHARE_PERMISSION = 'customers.saved-filter.share';
/** The saved filters of this list (customers.saved_filters). */
export const ATTRIBUTIONS_LIST_KEY = 'admin.customers.seller-attributions';

export const ATTRIBUTION_VIEWS = ['suspicious', 'all', 'active', 'rejected'] as const;
export type AttributionView = (typeof ATTRIBUTION_VIEWS)[number];

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 254;
export const ATTRIBUTION_PAGE_SIZES = [25, 50, 100] as const;
/** One decision takes at most this many accounts; "select all matching" is sent in chunks. */
export const DECIDE_MAX = 100;
/** "Select all matching" and an export by filter take at most this many rows. */
export const SELECT_MAX = 10_000;
/** An export takes at most this many ticked ids. */
export const EXPORT_IDS_MAX = 1000;

export type Direction = 'asc' | 'desc';

export interface AttributionFilters {
  readonly sellerId?: string;
  readonly status?: 'active' | 'rejected';
  readonly rejectReason?: 'seller-team' | 'admin';
  readonly flag?: 'link-burst';
  /** Days in the admin's panel time zone (else the Market's), YYYY-MM-DD. */
  readonly attributedFrom?: string;
  readonly attributedTo?: string;
}
export const ATTRIBUTION_FILTER_KEYS = [
  'sellerId',
  'status',
  'rejectReason',
  'flag',
  'attributedFrom',
  'attributedTo',
] as const satisfies readonly (keyof AttributionFilters)[];
export type AttributionFilterKey = (typeof ATTRIBUTION_FILTER_KEYS)[number];

export const attributionFilterCount = (filters: AttributionFilters): number =>
  ATTRIBUTION_FILTER_KEYS.filter((key) => filters[key] !== undefined).length;

export interface AttributionQuery {
  readonly view: AttributionView;
  readonly q: string;
  readonly filters: AttributionFilters;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_ATTRIBUTION_QUERY: AttributionQuery = {
  view: 'suspicious',
  q: '',
  filters: {},
  direction: 'desc',
  page: 1,
  pageSize: 25,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A search shorter than the API takes is not sent (the box says why). */
export const attributionSearchOf = (q: string): string | undefined => {
  const text = q.trim();
  return text.length >= SEARCH_MIN ? text : undefined;
};

/** The filters as the API takes them (also the `filters` of a saved document). */
export function attributionApiFilters(f: AttributionFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ATTRIBUTION_FILTER_KEYS) {
    const value = f[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The page's filters from the API's shape (a saved document); unknown values are dropped. */
export function attributionFiltersOfApi(
  raw: Readonly<Record<string, unknown>> | undefined,
): AttributionFilters {
  if (raw === undefined) return {};
  const out: Record<string, string> = {};
  const sellerId = raw['sellerId'];
  if (typeof sellerId === 'string' && UUID.test(sellerId)) out['sellerId'] = sellerId.toLowerCase();
  if (raw['status'] === 'active' || raw['status'] === 'rejected') out['status'] = raw['status'];
  if (raw['rejectReason'] === 'seller-team' || raw['rejectReason'] === 'admin') {
    out['rejectReason'] = raw['rejectReason'];
  }
  if (raw['flag'] === 'link-burst') out['flag'] = 'link-burst';
  for (const key of ['attributedFrom', 'attributedTo'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && DAY.test(value)) out[key] = value;
  }
  return out;
}

/** The selector part of a request: view, search and filters, as the API takes them. */
export function attributionSelectorOf(query: AttributionQuery) {
  const filters = attributionApiFilters(query.filters);
  const q = attributionSearchOf(query.q);
  return {
    view: query.view,
    ...(q === undefined ? {} : { q }),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
  };
}

export interface AttributionRow {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly sellerId: string;
  readonly attributedAt: string;
  readonly status: 'active' | 'rejected';
  readonly rejectReason: 'seller-team' | 'admin' | null;
  readonly flags: readonly string[];
  readonly decidedAt: string | null;
}

export interface AttributionsPage {
  readonly items: readonly AttributionRow[];
  readonly counts: Readonly<Record<AttributionView, number>>;
  readonly paging: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly maxRows: number;
  } | null;
  readonly nextCursor: string | null;
}

export type DecisionOutcome = 'changed' | 'unchanged' | 'not-found' | 'seller-team';
export interface DecisionAnswer {
  readonly results: readonly {
    readonly accountId: string;
    readonly outcome: DecisionOutcome;
    readonly status: 'active' | 'rejected' | null;
  }[];
}

/** The customer's name as a title: the display name, or the email when there is none. */
export const attributionTitleOf = (row: Pick<AttributionRow, 'displayName' | 'email'>) =>
  row.displayName !== null && row.displayName.trim() !== '' ? row.displayName : row.email;

export const ATTRIBUTION_OPTIONAL_COLUMNS = ['reason', 'flags', 'decided'] as const;
export type AttributionOptionalColumn = (typeof ATTRIBUTION_OPTIONAL_COLUMNS)[number];
export const ATTRIBUTION_DEFAULT_COLUMNS: readonly AttributionOptionalColumn[] = [
  'reason',
  'flags',
  'decided',
];

export function cleanAttributionColumns(
  stored: readonly string[] | null | undefined,
): readonly AttributionOptionalColumn[] {
  if (stored === null || stored === undefined) return ATTRIBUTION_DEFAULT_COLUMNS;
  return stored.filter((id): id is AttributionOptionalColumn =>
    (ATTRIBUTION_OPTIONAL_COLUMNS as readonly string[]).includes(id),
  );
}

// Saved filters (customers.saved_filters): the closed document a saved tab keeps.

export interface AttributionSavedPayload {
  readonly v: 1;
  readonly view: AttributionView;
  readonly q?: string;
  readonly filters?: Readonly<Record<string, unknown>>;
  readonly sort?: 'attributed';
  readonly direction?: Direction;
}

export interface AttributionSavedFilter {
  readonly id: string;
  readonly name: string;
  readonly visibility: 'me' | 'everyone';
  readonly payload: AttributionSavedPayload;
  readonly ownedByMe: boolean;
  readonly canManage: boolean;
  readonly count?: number | null;
}

export interface AttributionSavedAnswer {
  readonly items: readonly AttributionSavedFilter[];
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
}

export function attributionPayloadOf(query: AttributionQuery): AttributionSavedPayload {
  const q = attributionSearchOf(query.q);
  const filters = attributionApiFilters(query.filters);
  return {
    v: 1,
    view: query.view,
    ...(q === undefined ? {} : { q }),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    sort: 'attributed',
    direction: query.direction,
  };
}

export function attributionQueryOfPayload(
  payload: AttributionSavedPayload,
  pageSize: number,
): AttributionQuery {
  return {
    view: (ATTRIBUTION_VIEWS as readonly string[]).includes(payload.view)
      ? payload.view
      : 'suspicious',
    q: payload.q ?? '',
    filters: attributionFiltersOfApi(payload.filters),
    direction: payload.direction === 'asc' ? 'asc' : 'desc',
    page: 1,
    pageSize,
  };
}
