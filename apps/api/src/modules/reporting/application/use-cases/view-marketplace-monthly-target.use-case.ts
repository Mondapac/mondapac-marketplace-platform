import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import { SETTINGS_MONTHLY_REVENUE_TARGET_VIEW } from '../../../settings';
import { sumDays } from '../../domain/admin-kpi';
import { monthForecastOf, monthWindowOf, type MonthForecast } from '../../domain/month-forecast';
import type { AdminKpiDependencies } from '../admin-kpi-flow';

const logger = new Logger('ViewMarketplaceMonthlyTarget');

/** The Market's monthly revenue target, read from its owner (settings) with the caller's context. */
export interface MarketTargetSource {
  marketTarget(context: CallContext): Promise<Result<Money | null, AccessDenied>>;
}

export interface MonthlyTargetDependencies extends AdminKpiDependencies {
  readonly targets: MarketTargetSource;
}

export interface MonthlyTargetAnswer {
  readonly generatedAt: Temporal.Instant;
  /** The IANA zone the month and its days are counted in. */
  readonly timezone: string;
  readonly currency: string;
  /** When the newest rollup row behind the month to date was rebuilt; null with none. */
  readonly refreshedAt: Temporal.Instant | null;
  readonly figures: MonthForecast;
}

/** The class name of a thrown value (never its message). */
const nameOf = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.constructor.name)
    ? error.constructor.name
    : 'unknown';

/**
 * `reporting.view-marketplace-monthly-target` (dashboards v2, phase 2): the Market's GMV with tax
 * of the current calendar month to date (the admin KPI GMV basis: goods of paid seller orders on
 * their paid day, refunds not taken off), the whole month before, the month-end forecast (an
 * estimate, held back on the first three days) and the target from settings with the pace. Days
 * and the month are the Market's (ADR-0005). Money: keys `commission-payouts.settlement.view` and
 * the target's own `settings.monthly-revenue-target.view`; a platform admin acting as themselves.
 * The target is read before the unit (a facade call never runs inside one); one read-only unit.
 */
export class ViewMarketplaceMonthlyTarget extends UseCase<
  Record<string, never>,
  MonthlyTargetAnswer,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-monthly-target',
    rule: {
      kind: 'permissions',
      allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key, SETTINGS_MONTHLY_REVENUE_TARGET_VIEW.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MonthlyTargetDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<MonthlyTargetAnswer, AccessDenied>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const { market } = context;
    const now = this.deps.clock.now();
    const timezone = this.deps.zone.zoneOf(market);
    const currency = this.deps.zone.currencyOf(market);
    const window = monthWindowOf(now, timezone);
    try {
      const target = await this.deps.targets.marketTarget(context);
      if (!target.ok) return target;
      let amount: bigint | null = target.value === null ? null : target.value.amount;
      if (target.value !== null && target.value.currency !== currency) {
        // A target set before the Market changed its currency is not compared with this money.
        logger.warn({
          msg: 'reporting.monthly-target.currency-mismatch',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        amount = null;
      }
      const unit = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await Promise.all([
              this.deps.reader.dailyTotals(market, currency, window.toDate),
              this.deps.reader.dailyTotals(market, currency, window.lastMonth),
            ]),
          ),
        { readOnly: true },
      );
      if (!unit.ok) return err({ code: 'access.unavailable' });
      const [toDate, lastMonth] = unit.value;
      return ok({
        generatedAt: now,
        timezone,
        currency,
        refreshedAt: toDate.refreshedAt,
        figures: monthForecastOf({
          now,
          zone: timezone,
          monthToDate: sumDays(toDate.days).goodsAmount,
          lastMonthTotal: sumDays(lastMonth.days).goodsAmount,
          target: amount,
        }),
      });
    } catch (error) {
      logger.warn({
        msg: 'reporting.monthly-target.read-failed',
        thrown: nameOf(error),
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
  }
}
