import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { marketDayOf } from '../domain/facts';
import {
  checkDayRange,
  ledgerReadinessOf,
  matchLedgerDays,
  readinessWindow,
  type LedgerKindSums,
  type LedgerReadiness,
} from '../domain/ledger';
import type { DayRange } from '../domain/period';
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

export type NetFiguresFailure = AccessDenied | { readonly code: 'validation.failed' };

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
  const range = checkDayRange(input?.range, today);
  if (range === null) return err({ code: 'validation.failed' });
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
