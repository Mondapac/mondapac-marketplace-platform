import type { KpiPeriod } from './kpi-types.ts';
import { isKpiPeriod } from './kpi-types.ts';

// The custom range of the admin dashboard: what the address holds (`?period=custom&from=&to=`),
// the same checks as the API's (a range is at most 13 calendar months, both days included, and
// ends by the Market's today), and the query of the report download. All days are Market days
// (`YYYY-MM-DD`), never read through the viewer's zone.

/** A custom range is at most this many calendar months, both ends included (the API's limit). */
export const MAX_RANGE_MONTHS = 13;

export type RangeCode = 'required' | 'format' | 'after-to' | 'too-long' | 'future';

/** One refused field, as the API names it in `details.fields`. */
export interface RangeField {
  readonly path: string;
  readonly code: string;
}

/** What the address asks for: a preset, or a custom range (the days as typed, possibly empty). */
export type KpiSelection =
  | { readonly id: KpiPeriod }
  | { readonly id: 'custom'; readonly from: string; readonly to: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isMarketDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

const text = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * The first day a range ending on `to` may start on: `to` less 13 calendar months, plus one day
 * (a month end is clamped, so 31 March less 13 months starts on 1 March). Same rule as the API.
 */
export function earliestFrom(to: string): string {
  const match = DAY.exec(to);
  if (match === null) return to;
  const index = Number(match[1]) * 12 + Number(match[2]) - 1 - MAX_RANGE_MONTHS;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const day = Math.min(Number(match[3]), daysIn(year, month));
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return text(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** The Market's day now, in the Market's IANA zone (never the viewer's). */
export function marketToday(zone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * The refusals of a custom range, in the API's order and codes: each day is required and real,
 * then `from` is not after `to`, then the range is at most 13 months, then `to` is not after the
 * Market's today. At most one range refusal, like the API.
 */
export function validateRange(input: {
  readonly from: string;
  readonly to: string;
  readonly today: string;
}): RangeField[] {
  const { from, to, today } = input;
  const refusals: RangeField[] = [];
  if (from === '') refusals.push({ path: 'from', code: 'required' });
  else if (!isMarketDay(from)) refusals.push({ path: 'from', code: 'format' });
  if (to === '') refusals.push({ path: 'to', code: 'required' });
  else if (!isMarketDay(to)) refusals.push({ path: 'to', code: 'format' });
  if (refusals.length > 0) return refusals;
  if (from > to) return [{ path: 'from', code: 'after-to' }];
  if (from < earliestFrom(to)) return [{ path: 'from', code: 'too-long' }];
  if (to > today) return [{ path: 'to', code: 'future' }];
  return [];
}

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? '';

/** The selection of the address: a known preset, a custom range, or the default. */
export function selectionOf(params: SearchParams, fallback: KpiPeriod): KpiSelection {
  const period = first(params.period);
  if (period === 'custom') {
    return { id: 'custom', from: first(params.from), to: first(params.to) };
  }
  return { id: isKpiPeriod(period) ? period : fallback };
}

/** The address of a selection on the home page. */
export function selectionHref(selection: KpiSelection): string {
  if (selection.id !== 'custom') return `/?period=${selection.id}`;
  const query = new URLSearchParams({ period: 'custom', from: selection.from, to: selection.to });
  return `/?${query.toString()}`;
}

/** The period part of an API query (`dashboard/admin/kpis`, `reporting/admin/daily/export`). */
export function periodQuery(selection: KpiSelection): URLSearchParams {
  const params = new URLSearchParams({ period: selection.id });
  if (selection.id === 'custom') {
    params.set('from', selection.from);
    params.set('to', selection.to);
  }
  return params;
}

/** The query of the daily report download for the shown period or range. */
export function dailyExportQuery(selection: KpiSelection, format: 'csv' | 'xlsx'): string {
  const params = periodQuery(selection);
  params.set('format', format);
  return params.toString();
}

/** The relay path of the daily report (the panel allowlist carries it). */
export const DAILY_EXPORT_PATH = 'reporting/admin/daily/export';

/** The three keys the export's access rule needs together. */
export const EXPORT_PERMISSIONS = [
  'commission-payouts.settlement.view',
  'ordering.order.view',
  'reporting.marketplace-report.export',
] as const;

export const mayExport = (permissionKeys: readonly string[]): boolean =>
  EXPORT_PERMISSIONS.every((key) => permissionKeys.includes(key));
