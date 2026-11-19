import type { Id, Temporal } from '@mondapac/shared-kernel';

// The admin issuer-request list (super list phase 3, list 36; CLAUDE.md rule 14): the open
// "my issuer is not listed" requests of the Market with filters, sort, page numbers or
// Previous/Next, the row Actions menu and the export. Pure rules; the queue is bounded (tens in a
// Market, design 7.5), so the filter, sort and page run over one capped read.

export const ISSUER_REQUEST_LIST_VIEWS = ['all'] as const;
export type IssuerRequestListView = (typeof ISSUER_REQUEST_LIST_VIEWS)[number];

export const ISSUER_REQUEST_SORT_KEYS = ['submitted', 'type'] as const;
export type IssuerRequestSortKey = (typeof ISSUER_REQUEST_SORT_KEYS)[number];

export interface IssuerRequestSort {
  readonly key: IssuerRequestSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. */
export interface IssuerRequestFilter {
  readonly typeCode: string | null;
  readonly sellerId: Id<'Seller'> | null;
  /** A request id the admin pasted, exact. */
  readonly requestId: string | null;
  /** Submitted at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

export const EMPTY_ISSUER_REQUEST_FILTER: IssuerRequestFilter = Object.freeze({
  typeCode: null,
  sellerId: null,
  requestId: null,
  from: null,
  to: null,
});

export const ISSUER_REQUEST_ROW_ACTIONS = ['open', 'answer'] as const;
export type IssuerRequestRowAction = (typeof ISSUER_REQUEST_ROW_ACTIONS)[number];

/** The columns an export may add, in the order the panel's column picker lists them. */
export const ISSUER_REQUEST_EXPORT_COLUMNS = ['request-id', 'seller-id', 'documents'] as const;
export type IssuerRequestExportColumn = (typeof ISSUER_REQUEST_EXPORT_COLUMNS)[number];

/** What the filter and the sort read of one open request. */
export interface IssuerRequestSubject {
  readonly id: string;
  readonly sellerId: string;
  readonly typeCode: string;
  readonly createdAt: Temporal.Instant;
}

export function issuerRequestMatches(
  row: IssuerRequestSubject,
  filter: IssuerRequestFilter,
): boolean {
  if (filter.typeCode !== null && row.typeCode !== filter.typeCode) return false;
  if (filter.sellerId !== null && row.sellerId !== filter.sellerId) return false;
  if (filter.requestId !== null && row.id !== filter.requestId) return false;
  const at = row.createdAt.epochMilliseconds;
  if (filter.from !== null && at < filter.from.epochMilliseconds) return false;
  if (filter.to !== null && at >= filter.to.epochMilliseconds) return false;
  return true;
}

/** Sorts two requests; the id breaks every tie, so a page boundary never repeats a row. */
export function compareIssuerRequests(
  a: IssuerRequestSubject,
  b: IssuerRequestSubject,
  sort: IssuerRequestSort,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const primary =
    sort.key === 'submitted'
      ? a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds
      : a.typeCode < b.typeCode
        ? -1
        : a.typeCode > b.typeCode
          ? 1
          : 0;
  if (primary !== 0) return sign * primary;
  return sign * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
