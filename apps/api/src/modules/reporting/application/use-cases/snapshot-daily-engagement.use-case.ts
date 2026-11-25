import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { dayWindowOf, SNAPSHOT_LOOKBACK_DAYS, snapshotDaysDue } from '../../domain/engagement';
import { marketDayOf, type MarketDay } from '../../domain/facts';
import type { EngagementSources } from '../ports/engagement-sources';
import type { EngagementStore } from '../ports/engagement-store';
import type { MarketZone } from '../ports/market-zone';

export interface SnapshotEngagementDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: EngagementStore;
  readonly sources: EngagementSources;
  readonly zone: Pick<MarketZone, 'zoneOf'>;
  readonly clock: Clock;
}

export interface SnapshotEngagementCounts {
  /** Days written by this run. */
  readonly written: number;
  /** Days another run wrote first (their row is kept). */
  readonly alreadyWritten: number;
  /** Days an owner could not count now; tried again next run while inside the look-back. */
  readonly failedDays: number;
}

const logger = new Logger('SnapshotDailyEngagement');

/**
 * `reporting.snapshot-daily-engagement` (dashboards v2, phase 2): the nightly shopping-funnel
 * snapshot. Rule `system`. For each Market day of the last {@link SNAPSHOT_LOOKBACK_DAYS} that
 * ended at least two hours ago (the Market's zone, the injected Clock) and has no row, it asks the
 * owners for the day's counts (ordering's checkouts handed to engagement's count) and writes them
 * once. The look-back stays inside the 30-day guest retention and far inside the 12-month
 * account retention, so the behaviour of a day is still there when its row is written; a row once
 * written never changes, so a later opt-out, erasure or purge leaves it as it was. A day an owner
 * cannot count now is logged by its day and reason (no id) and tried again next run.
 */
export class SnapshotDailyEngagement extends UseCase<
  Record<string, never>,
  SnapshotEngagementCounts,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.snapshot-daily-engagement',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SnapshotEngagementDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<SnapshotEngagementCounts, never>> {
    const { market } = context;
    const zone = this.deps.zone.zoneOf(market);
    const now = this.deps.clock.now();
    const today = Temporal.PlainDate.from(marketDayOf(now, zone));
    const lookBack = {
      from: today.subtract({ days: SNAPSHOT_LOOKBACK_DAYS }).toString() as MarketDay,
      to: today.subtract({ days: 1 }).toString() as MarketDay,
    };
    const recorded = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.store.recordedDays(market, lookBack)),
      { readOnly: true },
    );
    if (!recorded.ok) throw new Error('reporting.snapshot-daily-engagement: read refused');
    let written = 0;
    let alreadyWritten = 0;
    let failedDays = 0;
    for (const day of snapshotDaysDue(now, zone, recorded.value)) {
      // The owners are read before the unit, like the fact reads (their own units).
      const counts = await this.deps.sources.funnelOf(context, dayWindowOf(day, zone));
      if (!counts.ok) {
        failedDays += 1;
        logger.warn({
          msg: 'reporting.engagement-snapshot.day-failed',
          day,
          reason: counts.error.code,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        continue;
      }
      const recordedAt = this.deps.clock.now();
      const unit = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.store.insertDay(market, { day, ...counts.value }, recordedAt)),
      );
      if (!unit.ok) throw new Error('reporting.snapshot-daily-engagement: write refused');
      if (unit.value) written += 1;
      else alreadyWritten += 1;
    }
    return ok({ written, alreadyWritten, failedDays });
  }
}
