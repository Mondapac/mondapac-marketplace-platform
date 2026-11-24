import { isPeriod, type Period } from './types.ts';

// What the address of the seller dashboard holds: a preset (`?period=7d`) or a custom range
// (`?period=custom&from=2026-09-01&to=2026-11-23`, Market days), and the query of the daily report
// download for it. The checks of a range itself are the shared ones in `@mondapac/ui`.

/** What the address asks for: a preset, or a custom range (the days as typed, possibly empty). */
export type Selection =
  { readonly id: Period } | { readonly id: 'custom'; readonly from: string; readonly to: string };

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? '';

/** The selection of the address: a known preset, a custom range, or the default. */
export function selectionOf(params: SearchParams, fallback: Period): Selection {
  const period = first(params.period);
  if (period === 'custom') return { id: 'custom', from: first(params.from), to: first(params.to) };
  return { id: isPeriod(period) ? period : fallback };
}

/**
 * The zone whose "today" a range may end on: the Market's, as the API judges a range in Market
 * days. Without it (an older session summary) the seller's own working zone, then UTC.
 */
export function rangeZoneOf(marketTimezone: string | undefined, sellerZone: string | null): string {
  if (typeof marketTimezone === 'string' && marketTimezone !== '') return marketTimezone;
  return sellerZone ?? 'UTC';
}

/** The address of a selection on the home page. */
export function selectionHref(selection: Selection): string {
  if (selection.id !== 'custom') return `/?period=${selection.id}`;
  const query = new URLSearchParams({ period: 'custom', from: selection.from, to: selection.to });
  return `/?${query.toString()}`;
}

/** The period part of an API query. */
export function periodQuery(selection: Selection): URLSearchParams {
  const params = new URLSearchParams({ period: selection.id });
  if (selection.id === 'custom') {
    params.set('from', selection.from);
    params.set('to', selection.to);
  }
  return params;
}

/** The query of the daily report download for the shown period or range. */
export function dailyExportQuery(selection: Selection, format: 'csv' | 'xlsx'): string {
  const params = periodQuery(selection);
  params.set('format', format);
  return params.toString();
}

/** The relay path of the daily report (the panel allowlist carries it). */
export const DAILY_EXPORT_PATH = 'reporting/seller/daily/export';

/** The two keys the export's access rule needs together. */
export const EXPORT_PERMISSIONS = [
  'ordering.seller-order.view',
  'reporting.seller-report.export',
] as const;

export const mayExport = (permissionKeys: readonly string[]): boolean =>
  EXPORT_PERMISSIONS.every((key) => permissionKeys.includes(key));
