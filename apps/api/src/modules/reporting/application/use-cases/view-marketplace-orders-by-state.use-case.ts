import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../../ordering';
import { ordersByStateOf, type OrdersByState } from '../../domain/orders-by-state';
import type { ResolvedPeriod } from '../../domain/period';
import {
  resolveKpiPeriod,
  type AdminKpiDependencies,
  type KpiFailure,
  type KpiInput,
} from '../admin-kpi-flow';

const logger = new Logger('ViewMarketplaceOrdersByState');

export interface OrdersByStateAnswer {
  readonly period: ResolvedPeriod;
  readonly generatedAt: Temporal.Instant;
  readonly byState: OrdersByState;
}

/**
 * `reporting.view-marketplace-orders-by-state` (dashboards v2, phase 2): the seller orders paid in
 * the period's Market days, by the state they were delivered to (a pickup counts in the store's
 * state), from `reporting.seller_orders` only. Counts, no money and no postcode: the key
 * `ordering.order.view`, a platform admin acting as themselves. One read-only unit (ADR-0025).
 */
export class ViewMarketplaceOrdersByState extends UseCase<
  KpiInput,
  OrdersByStateAnswer,
  KpiFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-orders-by-state',
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
  ): Promise<Result<OrdersByStateAnswer, KpiFailure>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const { market } = context;
    const now = this.deps.clock.now();
    const currency = this.deps.zone.currencyOf(market);
    const resolved = resolveKpiPeriod(this.deps, context, input.period, now);
    if (!resolved.ok) return resolved;
    const period = resolved.value;
    try {
      const unit = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.reader.ordersByState(market, currency, period.current)),
        { readOnly: true },
      );
      if (!unit.ok) return err({ code: 'access.unavailable' });
      return ok({ period, generatedAt: now, byState: ordersByStateOf(unit.value) });
    } catch (error) {
      logger.warn({
        msg: 'reporting.orders-by-state.read-failed',
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
