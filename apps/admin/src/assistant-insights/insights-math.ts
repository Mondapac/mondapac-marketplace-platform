import type { Insights, Range } from './types.ts';
import { INSIGHTS_PAGE_SIZE } from './types.ts';

/** A day of the Market's calendar, moved by whole days (calendar arithmetic, not instants). */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** The query of a range ending on `today` (a Market day taken from an earlier answer). */
export function rangeQuery(range: Range, today: string, page: number): string {
  const params = new URLSearchParams({
    from: addDays(today, 1 - Number(range)),
    to: today,
    page: String(page),
    pageSize: String(INSIGHTS_PAGE_SIZE),
  });
  return params.toString();
}

/** What one conversation cost on average, in whole US dollars; null with no conversation. */
export function averageCostUsd(totals: Insights['totals']): number | null {
  return totals.conversations > 0 ? totals.spendMicroUsd / totals.conversations / 1_000_000 : null;
}

/** Whether another page of groups follows this answer. */
export function hasMoreGroups(answer: Insights): boolean {
  const { total, page, pageSize } = answer.unanswered;
  return page * pageSize < total;
}
