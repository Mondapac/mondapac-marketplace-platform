import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { FieldError } from '../domain/conversation';
import {
  groupUnanswered,
  MAX_UNANSWERED_CANDIDATES,
  parseInsightsQuery,
  type UnansweredRow,
} from '../domain/insights';
import type { AssistantDependencies } from './assistant-dependencies';
import type { FeedbackInsight } from './ports/insights.repository';

export interface AssistantInsights {
  readonly from: Temporal.PlainDate;
  readonly to: Temporal.PlainDate;
  /** Every day of the range, with zeros for a day with no conversation. */
  readonly days: readonly {
    readonly day: Temporal.PlainDate;
    readonly conversations: number;
    readonly spendMicroUsd: number;
  }[];
  readonly totals: { readonly conversations: number; readonly spendMicroUsd: number };
  readonly feedback: FeedbackInsight & {
    /** Thumbs up as a share of all thumbs, 0 to 1 (4 decimals); null with no thumbs. */
    readonly upShare: number | null;
  };
  /** Assistant replies that showed the support card. */
  readonly handoffs: number;
  readonly unanswered: {
    /** Groups after grouping, at most 200. */
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    /** More flagged turns existed than were read: the rows cover the newest ones. */
    readonly truncated: boolean;
    readonly rows: readonly UnansweredRow[];
  };
}

export type ViewInsightsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] };

/**
 * The admin's read of how the assistant is doing (B3): conversations and spend per Market day,
 * the thumbs, support hand-offs, and the questions the assistant did not answer well, grouped
 * by normalized query. Buyer text is the masked text that was stored; nothing identifies the
 * buyer or the conversation.
 */
export async function viewInsights(
  deps: AssistantDependencies,
  context: CallContext,
  rawQuery: Record<string, unknown>,
): Promise<Result<AssistantInsights, ViewInsightsFailure>> {
  const { market } = context;
  const today = deps.calendar.dayOf(market, deps.clock.now());
  const query = parseInsightsQuery(rawQuery, today);
  if (!query.ok) return err({ code: 'validation.failed', fields: query.error });
  const { from, to, page, pageSize } = query.value;
  const fromAt = deps.calendar.startOf(market, from);
  const toAt = deps.calendar.startOf(market, to.add({ days: 1 }));

  return deps.unitOfWork.run<AssistantInsights, ViewInsightsFailure>(
    market,
    async () => {
      const rows = await deps.insights.days(market, from, to);
      const byDay = new Map(rows.map((row) => [row.day.toString(), row]));
      const days: AssistantInsights['days'][number][] = [];
      for (
        let day = from;
        day.until(to, { largestUnit: 'days' }).days >= 0;
        day = day.add({ days: 1 })
      ) {
        const row = byDay.get(day.toString());
        days.push({
          day,
          conversations: row?.conversations ?? 0,
          spendMicroUsd: row?.spendMicroUsd ?? 0,
        });
      }
      const feedback = await deps.insights.feedback(market, fromAt, toAt);
      const handoffs = await deps.insights.handoffs(market, fromAt, toAt);
      const candidates = await deps.insights.unanswered(
        market,
        fromAt,
        toAt,
        MAX_UNANSWERED_CANDIDATES + 1,
      );
      const grouped = groupUnanswered(candidates.slice(0, MAX_UNANSWERED_CANDIDATES));
      const given = feedback.up + feedback.down;
      return ok({
        from,
        to,
        days,
        totals: {
          conversations: days.reduce((sum, day) => sum + day.conversations, 0),
          spendMicroUsd: days.reduce((sum, day) => sum + day.spendMicroUsd, 0),
        },
        feedback: {
          ...feedback,
          upShare: given === 0 ? null : Math.round((feedback.up / given) * 10_000) / 10_000,
        },
        handoffs,
        unanswered: {
          total: grouped.length,
          page,
          pageSize,
          truncated: candidates.length > MAX_UNANSWERED_CANDIDATES,
          rows: grouped.slice((page - 1) * pageSize, page * pageSize),
        },
      });
    },
    { readOnly: true },
  );
}
