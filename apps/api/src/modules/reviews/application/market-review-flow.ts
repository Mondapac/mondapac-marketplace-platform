import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { isPlatformAdminActor } from '../../../platform/authz';
import type { FieldIssue, ReviewsFailure, SummaryFailure } from './failures';
import { activeSettings } from './market-switch';
import type { MarketReviewCount } from './ports/review.repository';
import type { ReviewsDependencies } from './reviews-dependencies';

export type { MarketReviewCount };

/** What the dashboard read answers besides its counts. */
export type MarketReviewsFailure =
  SummaryFailure | Extract<ReviewsFailure, { readonly code: 'access.denied' }>;

/** The most windows one call may ask for: the period and the one before it, with room to spare. */
export const MARKET_REVIEW_MAX_WINDOWS = 4;

/**
 * The admin dashboard's review numbers (dashboards v2, phase 2): for each window `[from, to)` the
 * reviews of the whole Market published in it, their stars and how many of each rating, counted by
 * their status now. Counts only: no text, no author, no product, no seller. The windows are pairs
 * of instants the caller worked out in the Market's zone (ADR-0005); this module knows no zone.
 * A platform admin only, read only, and `reviews.disabled` while the Market has reviews off.
 */
export async function countMarketReviews(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly windows?: unknown },
): Promise<Result<readonly MarketReviewCount[], MarketReviewsFailure>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const fields: FieldIssue[] = [];
  const windows: { from: Temporal.Instant; to: Temporal.Instant }[] = [];
  const raw = input?.windows;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MARKET_REVIEW_MAX_WINDOWS) {
    fields.push({ path: 'windows', code: 'range' });
  } else {
    raw.forEach((entry: unknown, index) => {
      const w = (entry ?? {}) as { from?: unknown; to?: unknown };
      const from = instantOf(w.from);
      const to = instantOf(w.to);
      if (from === null) fields.push({ path: `windows.${index}.from`, code: 'format' });
      if (to === null) fields.push({ path: `windows.${index}.to`, code: 'format' });
      if (from !== null && to !== null) {
        if (Temporal.Instant.compare(from, to) >= 0) {
          fields.push({ path: `windows.${index}.to`, code: 'range' });
        } else {
          windows.push({ from, to });
        }
      }
    });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.reviews.countPublishedForMarket(context.market, windows)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'reviews.unavailable' });
  return ok(read.value);
}

function instantOf(value: unknown): Temporal.Instant | null {
  if (typeof value !== 'string') return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
}
