import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { marketDayOf, type MarketDay } from '../domain/facts';
import {
  checkDayRangeFields,
  ledgerReadinessOf,
  matchLedgerDays,
  readinessWindow,
  type LedgerKindSums,
  type LedgerReadiness,
} from '../domain/ledger';
import type { DayRange, PeriodRefused } from '../domain/period';
import type { LedgerKpiReader } from './ports/ledger-kpi-reader';
import type { MarketZone } from './ports/market-zone';

const logger = new Logger('LedgerKpiFlow');

export interface LedgerKpiDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: LedgerKpiReader;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

/** A range of Market days, inclusive, at most 13 months, ending today at the latest. */
export interface NetFiguresInput {
  readonly range: { readonly from: string; readonly to: string };
}

/** A refused range names its fields, as every dashboard read does (`PeriodRefused`). */
export type NetFiguresFailure = AccessDenied | PeriodRefused;

/** What both net reads start from. */
export interface NetFigures {
  readonly range: DayRange;
  readonly currency: string;
  readonly timezone: string;
  readonly generatedAt: Temporal.Instant;
  /** When the newest ledger rollup row behind the sums was rebuilt; null with none. */
  readonly refreshedAt: Temporal.Instant | null;
  readonly readiness: LedgerReadiness;
  readonly sums: LedgerKindSums;
}

/**
 * Checks the range in the Market's days, then reads the range's ledger sums (every seller, or one)
 * and the readiness of the Market side by side in one read-only unit (ADR-0025). "Today" is the
 * Market's day, never UTC. A store failure is `access.unavailable`, logged by its class only.
 */
export async function readNetFigures(
  deps: LedgerKpiDependencies,
  context: CallContext,
  input: NetFiguresInput,
  sellerId: Id<'Seller'> | null,
): Promise<Result<NetFigures, NetFiguresFailure>> {
  const { market } = context;
  const now = deps.clock.now();
  const timezone = deps.zone.zoneOf(market);
  const currency = deps.zone.currencyOf(market);
  const today = marketDayOf(now, timezone);
  const checked = checkDayRangeFields(input?.range, today);
  if (!checked.ok) return err({ code: 'validation.failed', fields: checked.error });
  const range = checked.value;
  const window = readinessWindow(today);
  try {
    const unit = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await Promise.all([
            deps.reader.rangeSums(market, currency, range, sellerId),
            deps.reader.matchFacts(market, currency, window),
            deps.reader.backfillState(market),
          ]),
        ),
      { readOnly: true },
    );
    if (!unit.ok) return err({ code: 'access.unavailable' });
    const [sums, match, backfill] = unit.value;
    const days = matchLedgerDays(window, match.paid, match.commission, match.knownUnpaid);
    return ok({
      range,
      currency,
      timezone,
      generatedAt: now,
      refreshedAt: sums.refreshedAt,
      readiness: ledgerReadinessOf(backfill, window, days),
      sums: sums.sums,
    });
  } catch (error) {
    logger.warn({
      msg: 'reporting.net-figures.read-failed',
      thrown:
        error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.constructor.name)
          ? error.constructor.name
          : 'unknown',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
}

/** The ledger sums of a period's two ranges and the Market's readiness (the admin finance KPIs). */
export interface LedgerPeriodSums {
  readonly current: LedgerKindSums;
  readonly previous: LedgerKindSums;
  readonly readiness: LedgerReadiness;
}

/**
 * Reads the ledger sums of `current` and `previous` (every seller) and the readiness facts of the
 * window ending yesterday (`today` is the Market's day), side by side in one read-only unit
 * (ADR-0025). Null when the store fails (logged by class only): the caller's other numbers stay.
 */
export async function readLedgerPeriod(
  deps: Pick<LedgerKpiDependencies, 'unitOfWork' | 'reader'>,
  context: CallContext,
  currency: string,
  today: MarketDay,
  ranges: { readonly current: DayRange; readonly previous: DayRange },
): Promise<LedgerPeriodSums | null> {
  const { market } = context;
  const window = readinessWindow(today);
  try {
    const unit = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await Promise.all([
            deps.reader.rangeSums(market, currency, ranges.current, null),
            deps.reader.rangeSums(market, currency, ranges.previous, null),
            deps.reader.matchFacts(market, currency, window),
            deps.reader.backfillState(market),
          ]),
        ),
      { readOnly: true },
    );
    if (!unit.ok) return null;
    const [current, previous, match, backfill] = unit.value;
    const days = matchLedgerDays(window, match.paid, match.commission, match.knownUnpaid);
    return {
      current: current.sums,
      previous: previous.sums,
      readiness: ledgerReadinessOf(backfill, window, days),
    };
  } catch (error) {
    logger.warn({
      msg: 'reporting.ledger-period.read-failed',
      thrown:
        error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.constructor.name)
          ? error.constructor.name
          : 'unknown',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return null;
  }
}
