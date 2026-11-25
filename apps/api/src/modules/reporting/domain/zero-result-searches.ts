import { Temporal } from '@mondapac/shared-kernel';
import type { MarketDay } from './facts';
import type { DayRange } from './period';

// Zero-result searches of the admin dashboard (dashboards v2, phase 2). One row per Market day and
// query, written once by the nightly snapshot: a text the storefront search found nothing for that
// day (search's server-side note) and that at least ten distinct signed-in customers with
// personalization on searched that day (engagement's count). Nothing about a person is kept: the
// folded text, how many searched it and how often. A text below the minimum is never written, so
// its words never reach reporting.

/** One query of one Market day as the snapshot wrote it. */
export interface ZeroResultSearchDay {
  readonly day: MarketDay;
  /** The folded text (lower case, at most 50 characters). */
  readonly query: string;
  /** Distinct signed-in customers who searched it that day (at least ten). */
  readonly searchers: number;
  /** Their searches of it that day. */
  readonly searches: number;
}

/** The fewest distinct searchers a query needs on a day to be kept and shown. */
export const MIN_ZERO_RESULT_SEARCHERS = 10;
/** How many queries the dashboard shows. */
export const TOP_ZERO_RESULT_QUERIES = 10;

/** The longest text kept, as search folds it. */
export const MAX_ZERO_RESULT_QUERY_LENGTH = 50;

/**
 * The rows the snapshot writes of the owners' answer: lower-case text of 2 to
 * {@link MAX_ZERO_RESULT_QUERY_LENGTH} characters, whole counts with at least
 * {@link MIN_ZERO_RESULT_SEARCHERS} searchers and no fewer searches than searchers, the first row of
 * a text only. Anything else is dropped, never written (defence in depth; the table's CHECKs agree).
 */
export function keptZeroResultRows(
  rows: readonly Omit<ZeroResultSearchDay, 'day'>[],
): Omit<ZeroResultSearchDay, 'day'>[] {
  const seen = new Set<string>();
  const kept: Omit<ZeroResultSearchDay, 'day'>[] = [];
  for (const row of rows) {
    const length = Array.from(row.query).length;
    if (
      seen.has(row.query) ||
      length < 2 ||
      length > MAX_ZERO_RESULT_QUERY_LENGTH ||
      row.query !== row.query.toLowerCase() ||
      !Number.isSafeInteger(row.searchers) ||
      !Number.isSafeInteger(row.searches) ||
      row.searchers < MIN_ZERO_RESULT_SEARCHERS ||
      row.searches < row.searchers
    ) {
      continue;
    }
    seen.add(row.query);
    kept.push({ query: row.query, searchers: row.searchers, searches: row.searches });
  }
  return kept;
}

/** One query of the period. */
export interface ZeroResultQuery {
  readonly query: string;
  /** Searches over the period's days on which it returned nothing. */
  readonly searches: number;
  /** Each day's distinct searchers, summed: one who searched on two days counts twice. */
  readonly searcherDays: number;
  /** The days of the period it was kept for. */
  readonly days: number;
}

export type ZeroResultSearches =
  | {
      readonly status: 'not-enough-data';
      readonly minimumSearchers: number;
      readonly recordedDays: number;
      readonly periodDays: number;
    }
  | {
      readonly status: 'available';
      readonly queries: readonly ZeroResultQuery[];
      readonly recordedDays: number;
      readonly periodDays: number;
    };

/**
 * The top {@link TOP_ZERO_RESULT_QUERIES} queries of the period by searches (then by text), from
 * the rows of the period and the days the snapshot recorded. A row below
 * {@link MIN_ZERO_RESULT_SEARCHERS} is never shown (it cannot be written; this is defence in
 * depth). No query at all: `not-enough-data`.
 */
export function zeroResultSearchesOf(
  rows: readonly ZeroResultSearchDay[],
  recorded: ReadonlySet<MarketDay>,
  range: DayRange,
): ZeroResultSearches {
  const periodDays =
    Temporal.PlainDate.from(range.from).until(Temporal.PlainDate.from(range.to)).days + 1;
  const recordedDays = [...recorded].filter((day) => day >= range.from && day <= range.to).length;
  const byQuery = new Map<string, { searches: number; searcherDays: number; days: number }>();
  for (const row of rows) {
    if (row.day < range.from || row.day > range.to) continue;
    if (!(row.searchers >= MIN_ZERO_RESULT_SEARCHERS)) continue;
    const entry = byQuery.get(row.query) ?? { searches: 0, searcherDays: 0, days: 0 };
    entry.searches += row.searches;
    entry.searcherDays += row.searchers;
    entry.days += 1;
    byQuery.set(row.query, entry);
  }
  if (byQuery.size === 0) {
    return {
      status: 'not-enough-data',
      minimumSearchers: MIN_ZERO_RESULT_SEARCHERS,
      recordedDays,
      periodDays,
    };
  }
  const queries = [...byQuery]
    .map(([query, entry]) => ({ query, ...entry }))
    .sort((a, b) => b.searches - a.searches || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0))
    .slice(0, TOP_ZERO_RESULT_QUERIES);
  return { status: 'available', queries, recordedDays, periodDays };
}
