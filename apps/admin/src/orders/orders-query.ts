// The admin order list's query: what the filters and the sort ask GET ordering/admin/orders for.

export type ListPaging = 'pages' | 'prev-next';

export const PAGE_SIZE = 25;
/** The API stops page numbers at this row (ordering list contract); deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
export const MAX_PAGE = Math.floor(MAX_PAGED_ROWS / PAGE_SIZE);

export const PAYMENT_FILTERS = ['none', 'authorised', 'captured', 'voided'] as const;
export const FULFILMENT_FILTERS = ['to-ship', 'shipped', 'delivered'] as const;
export const SORTS = ['newest', 'oldest', 'total-high', 'total-low'] as const;
export type SortId = (typeof SORTS)[number];

const SORT_PARAMS: Readonly<Record<SortId, { sort: string; direction: string }>> = {
  newest: { sort: 'created', direction: 'desc' },
  oldest: { sort: 'created', direction: 'asc' },
  'total-high': { sort: 'total', direction: 'desc' },
  'total-low': { sort: 'total', direction: 'asc' },
};

export interface OrderFilters {
  readonly status: string;
  readonly paymentState: string;
  readonly fulfilment: string;
  /** Calendar days (yyyy-mm-dd) in the list's zone, the one the table shows; '' keeps every day. */
  readonly from: string;
  readonly to: string;
}

export const NO_FILTERS: OrderFilters = {
  status: 'all',
  paymentState: '',
  fulfilment: '',
  from: '',
  to: '',
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const WALL_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of an instant in a zone, as the UTC milliseconds of the same numbers. */
function wallMs(ms: number, zone: string): number {
  let format = WALL_FORMATS.get(zone);
  if (format === undefined) {
    // Machine reading, not display: Latin digits and a 24-hour clock whatever the Market locale.
    format = new Intl.DateTimeFormat('en-US', {
      numberingSystem: 'latn',
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    WALL_FORMATS.set(zone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/**
 * The first instant of a calendar day (yyyy-mm-dd) on the clock of an IANA zone, as an ISO
 * instant; `plus` days later for an exclusive end. Null for a value that is not a real day or a
 * zone this runtime does not know. Where clocks skip midnight, the day starts when they resume.
 */
export function startOfDay(day: string, zone: string, plus = 0): string | null {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = match.slice(1).map(Number) as [number, number, number];
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  const midnight = Date.UTC(year, month - 1, date + plus);
  try {
    // The offsets in force a day either side; the earliest instant at or after local midnight.
    const starts = [midnight - 86_400_000, midnight + 86_400_000]
      .map((probe) => midnight - (wallMs(probe, zone) - probe))
      .filter((ms) => wallMs(ms, zone) >= midnight)
      .sort((a, b) => a - b);
    const start = starts[0];
    return start === undefined ? null : new Date(start).toISOString();
  } catch {
    return null;
  }
}

/** True when both days are set and `to` is before `from`: the filter would match nothing. */
export const rangeIsBackwards = (filters: OrderFilters): boolean =>
  DAY.test(filters.from) && DAY.test(filters.to) && filters.to < filters.from;

export function queryOf(
  filters: OrderFilters,
  /** The IANA zone the days are read in (the holder's own, else the Market's; ADR-0005). */
  zone: string,
  mode:
    | { readonly paging: 'pages'; readonly page: number; readonly sort: SortId }
    | {
        readonly paging: 'prev-next';
        readonly cursor: string | null;
      },
): string {
  const params = new URLSearchParams();
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.paymentState !== '') params.set('paymentState', filters.paymentState);
  if (filters.fulfilment !== '') params.set('fulfilment', filters.fulfilment);
  const from = startOfDay(filters.from, zone);
  // The last day is included: the API's `to` is the first instant after it.
  const to = startOfDay(filters.to, zone, 1);
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  if (mode.paging === 'pages') {
    params.set('page', String(mode.page));
    params.set('pageSize', String(PAGE_SIZE));
    const sort = SORT_PARAMS[mode.sort];
    params.set('sort', sort.sort);
    params.set('direction', sort.direction);
  } else if (mode.cursor !== null) {
    params.set('cursor', mode.cursor);
  }
  return params.toString();
}

/** How many page buttons a total needs, never past the API's depth limit. */
export const pageCountOf = (total: number): number =>
  Math.min(MAX_PAGE, Math.max(1, Math.ceil(total / PAGE_SIZE)));
