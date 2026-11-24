import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../../ordering';
import {
  orderStatusOf,
  sameDayShareOf,
  type OrderStatusCounts,
  type SameDayShare,
} from '../../domain/admin-health';
import { marketDayOf } from '../../domain/facts';
import {
  resolvePeriod,
  windowOf,
  type InstantWindow,
  type ResolvedPeriod,
} from '../../domain/period';
import type { AdminKpiDependencies, KpiInput } from '../admin-kpi-flow';

const logger = new Logger('ViewMarketplaceOrderStatus');

export interface OrderStatusAnswer {
  readonly period: ResolvedPeriod;
  /** The Market's IANA zone the days are counted in. */
  readonly timezone: string;
  /** The instants of `period.current` (first day's start to the start of the day after the last). */
  readonly window: InstantWindow;
  readonly generatedAt: Temporal.Instant;
  readonly counts: OrderStatusCounts;
  /** Same-day deliveries ÷ paid; `not-available` until reporting holds the delivery method. */
  readonly sameDayShare: SameDayShare;
}

/**
 * `reporting.view-marketplace-order-status` (dashboards v2, phase 1, PR 6): the seller orders
 * paid in the period's Market days, by where they stand now (to ship, shipped, delivered,
 * cancelled, refunded; one bucket each), from `reporting.seller_orders` and `reporting.refunds`
 * only, and the same-day share. Counts, no money: the key `ordering.order.view`, a platform admin
 * acting as themselves. One read-only unit (ADR-0025).
 */
export class ViewMarketplaceOrderStatus extends UseCase<KpiInput, OrderStatusAnswer, AccessDenied> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-order-status',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminKpiDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: KpiInput,
  ): Promise<Result<OrderStatusAnswer, AccessDenied>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const { market } = context;
    const now = this.deps.clock.now();
    const timezone = this.deps.zone.zoneOf(market);
    const currency = this.deps.zone.currencyOf(market);
    const period = resolvePeriod(input.period, marketDayOf(now, timezone));
    try {
      const unit = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.reader.orderStatusTallies(market, currency, period.current)),
        { readOnly: true },
      );
      if (!unit.ok) return err({ code: 'access.unavailable' });
      return ok({
        period,
        timezone,
        window: windowOf(period.current, timezone),
        generatedAt: now,
        counts: orderStatusOf(unit.value),
        sameDayShare: sameDayShareOf(null),
      });
    } catch (error) {
      logger.warn({
        msg: 'reporting.order-status.read-failed',
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
}
