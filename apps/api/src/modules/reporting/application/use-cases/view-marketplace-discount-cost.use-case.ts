import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../../promotions';
import { discountCostOf, type DiscountCost } from '../../domain/discount-cost';
import { windowOf, type ResolvedPeriod } from '../../domain/period';
import { resolveKpiPeriod, type KpiFailure, type KpiInput } from '../admin-kpi-flow';
import type { DiscountSources } from '../ports/discount-sources';
import type { MarketZone } from '../ports/market-zone';

const logger = new Logger('ViewMarketplaceDiscountCost');

export interface DiscountCostDependencies {
  readonly sources: DiscountSources;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

export interface DiscountCostAnswer {
  readonly period: ResolvedPeriod;
  readonly generatedAt: Temporal.Instant;
  readonly currency: string;
  readonly cost: DiscountCost;
}

/**
 * `reporting.view-marketplace-discount-cost` (dashboards v2, phase 2): what the discounts of the
 * orders paid in the period's Market days cost, who funded them (Mondapac or the sellers), by kind,
 * against the period before, read from promotions (`promotions.sum-discount-cost`) for the
 * period and the period before, side by side. Keys `commission-payouts.settlement.view` and
 * `promotions.promotion.manage` (a promotions Viewer sees no spend), a platform admin acting as
 * themselves; promotions checks the same keys again. `not-enough-data` below five discounted orders. Nothing is stored in reporting.
 */
export class ViewMarketplaceDiscountCost extends UseCase<KpiInput, DiscountCostAnswer, KpiFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-discount-cost',
    rule: {
      kind: 'permissions',
      allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key, PROMOTIONS_PROMOTION_MANAGE.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DiscountCostDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: KpiInput,
  ): Promise<Result<DiscountCostAnswer, KpiFailure>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const { market } = context;
    const now = this.deps.clock.now();
    const resolved = resolveKpiPeriod(this.deps, context, input.period, now);
    if (!resolved.ok) return resolved;
    const period = resolved.value;
    const zone = this.deps.zone.zoneOf(market);
    const currency = this.deps.zone.currencyOf(market);
    try {
      const [current, previous] = await Promise.all([
        this.deps.sources.totalsOf(context, currency, windowOf(period.current, zone)),
        this.deps.sources.totalsOf(context, currency, windowOf(period.previous, zone)),
      ]);
      if (!current.ok) return err(current.error);
      if (!previous.ok) return err(previous.error);
      return ok({
        period,
        generatedAt: now,
        currency,
        cost: discountCostOf(current.value, previous.value),
      });
    } catch (error) {
      logger.warn({
        msg: 'reporting.discount-cost.read-failed',
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
