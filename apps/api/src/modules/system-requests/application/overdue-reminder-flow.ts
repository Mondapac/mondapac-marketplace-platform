import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { AREA_DEFAULTS, isPolicyArea, REVIEW_AREAS, type ReviewArea } from '../domain/areas';
import { SystemRequestOverdue } from '../domain/events';
import { startOfMarketDay, waitingDays } from '../domain/overdue';
import type { MarketZone } from './ports/market-zone';
import type { PolicyRepository } from './ports/policy.repository';
import type { RequestRepository } from './ports/request.repository';

/** What the reminder run needs: a smaller set than the admin use cases, no authorisation port. */
export interface OverdueReminderDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: RequestRepository;
  readonly policy: PolicyRepository;
  readonly outbox: OutboxWriter;
  readonly zone: MarketZone;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface OverdueReminderResult {
  /** Requests a reminder event was written for. */
  readonly reminded: number;
}

/** Requests handled per unit of the run, and the most one run handles (a job runs again soon). */
const BATCH = 50;
const MAX_PER_RUN = 1000;

const logger = new Logger('RemindOverdueSystemRequests');

/** The areas whose review is on in the Market now (the review policy is always on). */
async function reviewedAreas(
  deps: OverdueReminderDependencies,
  context: CallContext,
): Promise<readonly ReviewArea[]> {
  const unit = await deps.unitOfWork.run<readonly ReviewArea[], never>(
    context.market,
    async () => {
      const rows = await deps.policy.areas(context.market);
      const enabled = new Map(rows.map((row) => [row.area, row.enabled]));
      return ok(
        REVIEW_AREAS.filter(
          (area) => !isPolicyArea(area) || (enabled.get(area) ?? AREA_DEFAULTS[area].enabled),
        ),
      );
    },
    { readOnly: true },
  );
  if (!unit.ok) throw new Error('system-requests.overdue-reminder: the policy could not be read');
  return unit.value;
}

/**
 * `RemindOverdueSystemRequests`: for one Market, writes one `request-overdue` event for each open
 * request that is past its review date, whose area is still reviewed, and that was not reminded
 * today (the Market's calendar day, in its zone). The stamp (`last_reminded_at`, set with a
 * conditional update) and the outbox event are written in one unit, so a restart or two runs at
 * once never send a request's reminder twice; a decided request or an area turned off stops them.
 * The event holds the request's id, SR number, area and age only: never the note or the values.
 */
export async function remindOverdue(
  deps: OverdueReminderDependencies,
  context: CallContext,
): Promise<Result<OverdueReminderResult, never>> {
  const { market } = context;
  const now = deps.clock.now();
  const zone = deps.zone.zoneOf(market);
  const dayStart = startOfMarketDay(now, zone);
  const areas = await reviewedAreas(deps, context);
  let reminded = 0;
  let handled = 0;
  while (handled < MAX_PER_RUN) {
    const batch = await deps.unitOfWork.run<number, never>(market, async () => {
      const due = await deps.requests.dueForReminder(market, {
        now,
        remindedBefore: dayStart,
        areas,
        limit: BATCH,
      });
      let sent = 0;
      for (const request of due) {
        // The conditional stamp is the claim: false means another run, or a decision, won.
        if (!(await deps.requests.markReminded(market, request.id, now, dayStart))) continue;
        await deps.outbox.append(context, [
          SystemRequestOverdue.record({
            aggregateId: deps.ids.next(),
            aggregateVersion: 1,
            occurredAt: now,
            payload: {
              requestId: request.id,
              number: request.number,
              area: request.area,
              ageDays: waitingDays(request.appliedAt, now, zone),
            },
          }),
        ]);
        sent += 1;
      }
      return ok(due.length === 0 ? -1 : sent);
    });
    if (!batch.ok) throw new Error('system-requests.overdue-reminder: the unit failed');
    // A batch that found nothing, or whose rows were all claimed by others, ends the run.
    if (batch.value <= 0) break;
    reminded += batch.value;
    handled += BATCH;
  }
  logger.log({
    msg: 'system-requests.overdue-reminders-written',
    reminded,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return ok({ reminded });
}
