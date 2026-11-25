import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { dayWindowOf, SNAPSHOT_LOOKBACK_DAYS, snapshotDaysDue } from '../../domain/engagement';
import { marketDayOf, type MarketDay } from '../../domain/facts';
import { keptZeroResultRows } from '../../domain/zero-result-searches';
import type { MarketZone } from '../ports/market-zone';
import type { SearchSources } from '../ports/search-sources';
import type { SearchStore } from '../ports/search-store';
import type { SnapshotEngagementCounts } from './snapshot-daily-engagement.use-case';

export interface SnapshotSearchesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: SearchStore;
  readonly sources: SearchSources;
  readonly zone: Pick<MarketZone, 'zoneOf'>;
  readonly clock: Clock;
}

const logger = new Logger('SnapshotDailySearches');

/**
 * `reporting.snapshot-daily-searches` (dashboards v2, phase 2): the nightly zero-result search
 * snapshot. Rule `system`. For each Market day of the last {@link SNAPSHOT_LOOKBACK_DAYS} that
 * ended at least two hours ago (the Market's zone, the injected Clock) and has no day row, it asks
 * search for the texts it found nothing for that day and engagement for how many distinct
 * signed-in customers searched each; it writes the day row and the texts searched by at least ten
 * (the rest are never written), once. The look-back stays inside search's 35-day retention of its
 * notes. A day an owner cannot count now is logged by its day and reason (never a text) and tried
 * again next run; one over engagement's cap is tried once per process.
 */
export class SnapshotDailySearches extends UseCase<
  Record<string, never>,
  SnapshotEngagementCounts,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.snapshot-daily-searches',
    rule: { kind: 'system' },
  };

  /** `<market>|<day>` of the days found over an owner's cap; not asked again by this process. */
  readonly #overCap = new Set<string>();

  constructor(
    gate: UseCaseGate,
    private readonly deps: SnapshotSearchesDependencies,
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
    if (!recorded.ok) throw new Error('reporting.snapshot-daily-searches: read refused');
    let written = 0;
    let alreadyWritten = 0;
    let failedDays = 0;
    let cappedDays = 0;
    for (const day of snapshotDaysDue(now, zone, recorded.value)) {
      const key = `${market.marketId}|${day}`;
      if (this.#overCap.has(key)) {
        cappedDays += 1;
        continue;
      }
      // The owners are read before the unit, each in its own.
      const counts = await this.deps.sources.zeroResultSearchesOf(context, dayWindowOf(day, zone));
      if (!counts.ok) {
        failedDays += 1;
        if (counts.error.overCap === true) this.#overCap.add(key);
        logger.warn({
          msg: 'reporting.search-snapshot.day-failed',
          day,
          reason: counts.error.code,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        continue;
      }
      const rows = keptZeroResultRows(counts.value);
      const recordedAt = this.deps.clock.now();
      const unit = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.store.insertDay(market, day, rows, recordedAt)),
      );
      if (!unit.ok) throw new Error('reporting.snapshot-daily-searches: write refused');
      if (unit.value) written += 1;
      else alreadyWritten += 1;
    }
    return ok({ written, alreadyWritten, failedDays, cappedDays });
  }
}
