import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { fillDays, type DayTotals } from '../domain/admin-kpi';
import { marketDayOf } from '../domain/facts';
import { resolvePeriod, type PeriodId, type ResolvedPeriod } from '../domain/period';
import type { AdminKpiReader } from './ports/admin-kpi-reader';
import type { MarketZone } from './ports/market-zone';

export interface AdminKpiDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: AdminKpiReader;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

export interface KpiInput {
  readonly period: PeriodId;
}

/** What both KPI reads start from: the period, in Market days, and its two filled ranges. */
export interface KpiRanges {
  readonly period: ResolvedPeriod;
  readonly currency: string;
  readonly generatedAt: Temporal.Instant;
  /** When the newest rollup row behind the numbers was rebuilt; null with none. */
  readonly refreshedAt: Temporal.Instant | null;
  readonly current: DayTotals[];
  readonly previous: DayTotals[];
}

const logger = new Logger('AdminKpiFlow');

/**
 * Reads the current and the previous range of the period in the Market's currency, one grouped
 * read each, side by side in one read-only unit (ADR-0025: no transaction). "Today" is the
 * Market's day, never the UTC day. A store failure is `access.unavailable`, logged by its class.
 */
export async function readKpiRanges(
  deps: AdminKpiDependencies,
  context: CallContext,
  input: KpiInput,
): Promise<Result<KpiRanges, AccessDenied>> {
  const now = deps.clock.now();
  const period = resolvePeriod(input.period, marketDayOf(now, deps.zone.zoneOf(context.market)));
  const currency = deps.zone.currencyOf(context.market);
  try {
    const unit = await deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await Promise.all([
            deps.reader.dailyTotals(context.market, currency, period.current),
            deps.reader.dailyTotals(context.market, currency, period.previous),
          ]),
        ),
      { readOnly: true },
    );
    if (!unit.ok) return err({ code: 'access.unavailable' });
    const [current, previous] = unit.value;
    const refreshed = [current.refreshedAt, previous.refreshedAt].filter((at) => at !== null);
    const refreshedAt = refreshed.reduce<Temporal.Instant | null>(
      (latest, at) =>
        latest === null || at.epochMilliseconds > latest.epochMilliseconds ? at : latest,
      null,
    );
    return ok({
      period,
      currency,
      generatedAt: now,
      refreshedAt,
      current: fillDays(period.current, current.days),
      previous: fillDays(period.previous, previous.days),
    });
  } catch (error) {
    logger.warn({
      msg: 'reporting.admin-kpis.read-failed',
      thrown:
        error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.constructor.name)
          ? error.constructor.name
          : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
}
