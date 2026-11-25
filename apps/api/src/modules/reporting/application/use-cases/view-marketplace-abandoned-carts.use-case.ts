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
import { abandonedCartsOf, type AbandonedCarts } from '../../domain/abandoned-carts';
import type { ResolvedPeriod } from '../../domain/period';
import { resolveKpiPeriod, type KpiFailure, type KpiInput } from '../admin-kpi-flow';
import type { AbandonedCartsStore } from '../ports/abandoned-carts-store';
import type { MarketZone } from '../ports/market-zone';

const logger = new Logger('ViewMarketplaceAbandonedCarts');

export interface AbandonedCartsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: AbandonedCartsStore;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

export interface AbandonedCartsAnswer {
  readonly period: ResolvedPeriod;
  readonly generatedAt: Temporal.Instant;
  readonly abandonedCarts: AbandonedCarts;
}

/**
 * `reporting.view-marketplace-abandoned-carts` (dashboards v2, phase 2): the abandoned carts of
 * the period's latest snapshot day against the period before, from `reporting.daily_abandoned_carts`
 * only (a count and an approximate value, never a cart or a person). Key `ordering.order.view`,
 * like the shopping funnel, a platform admin acting as themselves. `not-enough-data` below five
 * carts. One read-only unit (ADR-0025).
 */
export class ViewMarketplaceAbandonedCarts extends UseCase<
  KpiInput,
  AbandonedCartsAnswer,
  KpiFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-abandoned-carts',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AbandonedCartsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: KpiInput,
  ): Promise<Result<AbandonedCartsAnswer, KpiFailure>> {
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
        abandonedCarts: abandonedCartsOf(current, previous, period.current),
      });
    } catch (error) {
      logger.warn({
        msg: 'reporting.abandoned-carts.read-failed',
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
