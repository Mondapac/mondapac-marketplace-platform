// The query string of the seller ledger list: what the search, filters, sort and page ask
// GET commission-payouts/admin/sellers/:id/ledger for. Page numbers (List paging `pages`) send
// `page`, `pageSize`, `sort` and `direction`; Previous and next sends `limit` and `cursor` only,
// newest record first (the API refuses a sort beside a cursor). The seller is in the path, never
// in the query.

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { numberFormat } from '../../shared/intl.ts';
import { exponentOf } from '../../shipping/money.ts';
import type { AmountStep, Query } from './ledger-list-types.ts';

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  /** The ledger's currency: the amount steps are whole units of it. */
  readonly currency: string;
  readonly now: Date;
}

/** "100" whole units of a currency as minor units: 10,000 for AUD, 100 for JPY. */
export const minorOfStep = (step: AmountStep, currency: string): string =>
  `${step}${'0'.repeat(exponentOf(currency))}`;

/**
 * The keys that choose which rows the list holds (an export of "all matching" sends these).
 * `q` is the order or seller order id (the search route has already made it lower case).
 */
export function selectorParams(
  query: Query,
  context: QueryContext,
  search: string,
): URLSearchParams {
  const params = new URLSearchParams();
  if (search !== '') params.set('q', search);
  const { filters } = query;
  if (filters.kind !== undefined) params.set('kind', filters.kind);
  if (filters.side !== undefined) params.set('side', filters.side);
  if (filters.recorded !== undefined) {
    const range = presetRange(filters.recorded, context.zone, context.now);
    if (range !== null) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  }
  if (filters.minAmount !== undefined) {
    params.set('minAmount', minorOfStep(filters.minAmount, context.currency));
  }
  if (filters.maxAmount !== undefined) {
    params.set('maxAmount', minorOfStep(filters.maxAmount, context.currency));
  }
  return params;
}

export function queryString(query: Query, context: QueryContext, search: string): string {
  const params = selectorParams(query, context, search);
  if (context.paging === 'pages') {
    params.set('sort', query.sort);
    params.set('direction', query.direction);
    params.set('page', String(query.page));
    params.set('pageSize', String(query.pageSize));
  } else {
    params.set('limit', String(query.pageSize));
    const cursor = query.cursors[query.cursors.length - 1];
    if (cursor !== undefined) params.set('cursor', cursor);
  }
  return params.toString();
}

/** "100" as the Market writes whole units of the currency: "$100", "¥100". */
export const stepLabel = (step: AmountStep, currency: string, locale: string): string =>
  numberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    Number(step),
  );
