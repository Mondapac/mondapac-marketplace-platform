// The query string of the Earnings payout list: what the view, search, filters, sort and page ask
// GET commission-payouts/seller/payouts for. Page numbers (List paging `pages`) send `page`,
// `pageSize`, `sort` and `direction`; Previous and next sends `limit` and `cursor` only (and
// `sort=created` when the planned day is the sort): the API refuses a direction or the amount
// sort beside a cursor, and the cursor names the sort it walks.
//
// The payout day is `slotAt` everywhere (list column, sort, cursor, `from` and `to`). Its presets
// are read on the clock of the STORE's zone (ADR-0005), not the Market's, so a preset matches the
// day the column shows.

import { presetRange, todayIn } from '../../orders/date-presets.ts';
import { startOfDay } from '../../orders/orders-day.ts';
import type { ListPaging } from '../payout-types.ts';
import {
  DEFAULT_QUERY,
  statusOfView,
  type AmountStep,
  type PayoutPreset,
  type Query,
} from './payouts-list-types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PayoutSearch =
  | { readonly kind: 'none' }
  /** Text that is not a payout id: nothing is asked, and the box says what to type. */
  | { readonly kind: 'not-an-id' }
  | { readonly kind: 'id'; readonly value: string };

/** The one search finds a payout by its whole id (the API matches it exactly). */
export function payoutSearchRoute(text: string): PayoutSearch {
  const value = text.trim();
  if (value === '') return { kind: 'none' };
  return UUID.test(value) ? { kind: 'id', value: value.toLowerCase() } : { kind: 'not-an-id' };
}

/** A half-open range of instants: `from` at or after, `to` before. */
export interface InstantRange {
  readonly from: string;
  readonly to: string;
}

/**
 * The instants a payout day preset means on the clock of `zone` at `now`. The shared presets are
 * the orders list's. "Next 7 days" and "Next 30 days" start with today's day and run that many days
 * on (today and the 6 or 29 days after it). Null when the zone is unknown.
 */
export function payoutRange(preset: PayoutPreset, zone: string, now: Date): InstantRange | null {
  if (preset !== 'next-7-days' && preset !== 'next-30-days') return presetRange(preset, zone, now);
  const today = todayIn(zone, now);
  if (today === null) return null;
  const from = startOfDay(today, zone, 0);
  const to = startOfDay(today, zone, preset === 'next-7-days' ? 7 : 30);
  return from === null || to === null ? null : { from, to };
}

/** A whole-unit step as minor units of a currency with `exponent` decimals ("10", 2 is "1000"). */
export const minorOfStep = (step: AmountStep, exponent: number): string =>
  `${step}${'0'.repeat(exponent)}`;

export interface QueryContext {
  readonly paging: ListPaging;
  /** The store's IANA zone: the day presets are read on its clock. */
  readonly zone: string;
  readonly now: Date;
  /** Decimals of the list's currency, for the amount steps. */
  readonly exponent: number;
}

/** The keys that choose which rows the list holds (an export of "all matching" sends these). */
export function selectorParams(query: Query, context: QueryContext): URLSearchParams {
  const params = new URLSearchParams();
  const status = statusOfView(query.view);
  if (status !== null) params.set('status', status);
  const route = payoutSearchRoute(query.q);
  if (route.kind === 'id') params.set('q', route.value);
  const { filters } = query;
  if (filters.payoutOn !== undefined) {
    const range = payoutRange(filters.payoutOn, context.zone, context.now);
    if (range !== null) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  }
  if (filters.minAmount !== undefined) {
    params.set('minAmount', minorOfStep(filters.minAmount, context.exponent));
  }
  if (filters.maxAmount !== undefined) {
    params.set('maxAmount', minorOfStep(filters.maxAmount, context.exponent));
  }
  return params;
}

export function queryString(query: Query, context: QueryContext): string {
  const params = selectorParams(query, context);
  if (context.paging === 'pages') {
    params.set('sort', query.sort);
    params.set('direction', query.direction);
    params.set('page', String(query.page));
    params.set('pageSize', String(query.pageSize));
  } else {
    params.set('limit', String(query.pageSize));
    // Latest first by the payout day (the default) or by the planned day; never the amount.
    if (query.sort === 'created') params.set('sort', 'created');
    const cursor = query.cursors[query.cursors.length - 1];
    if (cursor !== undefined) params.set('cursor', cursor);
  }
  return params.toString();
}

/** The first page the page server reads: every payout, latest payout day first. */
export const firstPageQuery = (paging: ListPaging): string =>
  queryString(DEFAULT_QUERY, { paging, zone: 'UTC', now: new Date(), exponent: 0 });
