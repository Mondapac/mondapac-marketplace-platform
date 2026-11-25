import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Money, Result, Temporal } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { sessionSellerOf } from '../../../../platform/work-queue/count-work-queue';
import { ORDERING_SELLER_ORDER_VIEW } from '../../../ordering';
import { monthForecastOf, monthWindowOf, type MonthForecast } from '../../domain/month-forecast';
import type { SellerKpiDayRow } from '../../domain/seller-kpis';
import type { MarketZone } from '../ports/market-zone';
import type { SellerGoalStore } from '../ports/seller-goal-store';
import type { SellerKpiReader } from '../ports/seller-kpi-reader';

const logger = new Logger('ViewSellerMonthlyGoal');

export interface SellerGoalDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: SellerKpiReader;
  readonly goals: SellerGoalStore;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

export interface SellerGoalAnswer {
  readonly generatedAt: Temporal.Instant;
  readonly timezone: string;
  readonly currency: string;
  /** The goal row's version for the edit (0: no goal set for the month). */
  readonly version: number;
  readonly figures: MonthForecast;
}

/** Sales with GST of the rows (the seller KPI sales basis). */
export const salesOf = (rows: readonly SellerKpiDayRow[]): bigint =>
  rows.reduce((sum, row) => sum + row.goodsAmount, 0n);

/**
 * `reporting.view-seller-monthly-goal` (dashboards v2, phase 2): the session seller's sales with
 * GST of the current calendar month to date (the seller KPI sales basis), the whole month before,
 * the month-end forecast (an estimate, held back on the first three days) and the seller's own
 * goal for the month with the pace. Days are the Market's, as every reporting figure is (the
 * rollups are by Market day). Rule: `ordering.seller-order.view`, like the seller KPIs, denied
 * while the seller is not approved; always the session's seller, never an id from input; Login as
 * Seller reads as the seller does. One read-only unit.
 */
export class ViewSellerMonthlyGoal extends UseCase<
  Record<string, never>,
  SellerGoalAnswer,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-seller-monthly-goal',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerGoalDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<SellerGoalAnswer, AccessDenied>> {
    const sellerId = sessionSellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { market } = context;
    const now = this.deps.clock.now();
    const timezone = this.deps.zone.zoneOf(market);
    const currency = this.deps.zone.currencyOf(market);
    const window = monthWindowOf(now, timezone);
    try {
      const unit = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await Promise.all([
              this.deps.goals.find(market, sellerId, window.month),
              this.deps.reader.daily(market, sellerId, currency, window.toDate),
              this.deps.reader.daily(market, sellerId, currency, window.lastMonth),
            ]),
          ),
        { readOnly: true },
      );
      if (!unit.ok) return err({ code: 'access.unavailable' });
      const [goal, toDate, lastMonth] = unit.value;
      const target: Money | null =
        goal !== null && goal.goal.currency === currency ? goal.goal : null;
      return ok({
        generatedAt: now,
        timezone,
        currency,
        version: goal?.version ?? 0,
        figures: monthForecastOf({
          now,
          zone: timezone,
          monthToDate: salesOf(toDate),
          lastMonthTotal: salesOf(lastMonth),
          target: target === null ? null : target.amount,
        }),
      });
    } catch (error) {
      logger.warn({
        msg: 'reporting.seller-goal.read-failed',
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
        sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
  }
}
