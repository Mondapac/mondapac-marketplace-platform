// The unanswered-questions list is read whole (the route keeps at most 200 groups), so the view,
// search, filters and sort run here, on the masked text the route sent.

import type { Query, Reason, Sort, UnansweredRow, View } from './types.ts';

/** Lower case, no accents or punctuation: the same folding the route groups by. */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const VIEW_REASONS: Readonly<Record<View, readonly Reason[] | null>> = {
  all: null,
  'thumbs-down': ['thumbs-down'],
  'no-results': ['no-results'],
  failed: ['unavailable', 'tool-failed'],
};

const reasonCount = (row: UnansweredRow, reasons: readonly Reason[]): number =>
  reasons.reduce((sum, reason) => sum + (row.reasons[reason] ?? 0), 0);

export function inView(row: UnansweredRow, view: View): boolean {
  const reasons = VIEW_REASONS[view];
  return reasons === null || reasonCount(row, reasons) > 0;
}

/** The count of each view, for its tab. */
export function viewCounts(rows: readonly UnansweredRow[]): Readonly<Record<View, number>> {
  return {
    all: rows.length,
    'thumbs-down': rows.filter((row) => inView(row, 'thumbs-down')).length,
    'no-results': rows.filter((row) => inView(row, 'no-results')).length,
    failed: rows.filter((row) => inView(row, 'failed')).length,
  };
}

export function matches(row: UnansweredRow, query: Query): boolean {
  if (!inView(row, query.view)) return false;
  const reason = query.filters.reason as Reason | undefined;
  if (reason !== undefined && (row.reasons[reason] ?? 0) === 0) return false;
  const min = query.filters.minCount;
  if (min !== undefined && row.count < Number(min)) return false;
  const words = fold(query.q);
  return words === '' || fold(row.query).includes(words);
}

/** One fixed locale, so the order does not depend on the machine. */
const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

const compare: Readonly<Record<Sort, (a: UnansweredRow, b: UnansweredRow) => number>> = {
  count: (a, b) => a.count - b.count,
  last: (a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt),
  query: (a, b) => COLLATOR.compare(a.query, b.query),
};

/** The rows that match, in the chosen order; ties keep the route's order (most asked, newest). */
export function visibleRows(rows: readonly UnansweredRow[], query: Query): UnansweredRow[] {
  const sign = query.direction === 'asc' ? 1 : -1;
  return rows
    .filter((row) => matches(row, query))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => sign * compare[query.sort](a.row, b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/** A stable id for a group inside one answer: the folded query (the route groups by it). */
export const rowId = (row: UnansweredRow): string => fold(row.query) || row.query;
