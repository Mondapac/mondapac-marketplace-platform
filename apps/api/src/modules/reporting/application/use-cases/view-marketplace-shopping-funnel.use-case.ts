import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ORDERING_ORDER_VIEW } from '../../../ordering';
import { shoppingFunnelOf, type ShoppingFunnel } from '../../domain/engagement';
import type { ResolvedPeriod } from '../../domain/period';
import { resolveKpiPeriod, type KpiFailure, type KpiInput } from '../admin-kpi-flow';
import type { EngagementStore } from '../ports/engagement-store';
import type { MarketZone } from '../ports/market-zone';

const logger = new Logger('ViewMarketplaceShoppingFunnel');

export interface ShoppingFunnelDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: EngagementStore;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

export interface ShoppingFunnelAnswer {
  readonly period: ResolvedPeriod;
  readonly generatedAt: Temporal.Instant;
  readonly funnel: ShoppingFunnel;
}

/**
 * `reporting.view-marketplace-shopping-funnel` (dashboards v2, phase 2): the shopping funnel of
 * the period and the period before, from `reporting.daily_engagement` only (signed-in customers
 * with personalization on; counts, never a person). Key `ordering.order.view`, like the other
 * order-count sections, a platform admin acting as themselves. `not-enough-data` below 20 viewers;
 * a step under five is hidden. One read-only unit (ADR-0025).
 */
export class ViewMarketplaceShoppingFunnel extends UseCase<
  KpiInput,
  ShoppingFunnelAnswer,
  KpiFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-shopping-funnel',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShoppingFunnelDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: KpiInput,
  ): Promise<Result<ShoppingFunnelAnswer, KpiFailure>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const { market } = context;
    const now = this.deps.clock.now();
    const resolved = resolveKpiPeriod(this.deps, context, input.period, now);
    if (!resolved.ok) return resolved;
    const period = resolved.value;
    try {
      const unit = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await Promise.all([
              this.deps.store.days(market, period.current),
              this.deps.store.days(market, period.previous),
            ]),
          ),
        { readOnly: true },
      );
      if (!unit.ok) return err({ code: 'access.unavailable' });
      const [current, previous] = unit.value;
      return ok({
        period,
        generatedAt: now,
        funnel: shoppingFunnelOf(current, previous, period.current),
      });
    } catch (error) {
      logger.warn({
        msg: 'reporting.shopping-funnel.read-failed',
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
