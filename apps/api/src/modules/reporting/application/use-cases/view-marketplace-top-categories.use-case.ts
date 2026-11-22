import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { Logger } from '@nestjs/common';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import { marketDayOf } from '../../domain/facts';
import { topCategoryRowOf, type TopCategoryRow } from '../../domain/admin-kpi';
import { resolvePeriod, type ResolvedPeriod } from '../../domain/period';
import type { AdminKpiDependencies, KpiInput } from '../admin-kpi-flow';

/** The dashboard table never shows more than five rows (design section 6). */
export const TOP_CATEGORIES_LIMIT = 5;

export interface TopCategoriesAnswer {
  readonly period: ResolvedPeriod;
  readonly currency: string;
  readonly generatedAt: Temporal.Instant;
  /** Biggest sales first, at most {@link TOP_CATEGORIES_LIMIT}; empty when nothing sold. */
  readonly rows: readonly TopCategoryRow[];
}

const logger = new Logger('ViewMarketplaceTopCategories');

/**
 * `reporting.view-marketplace-top-categories` (dashboards upgrade phase 5): the five categories
 * with the most goods sold in a period (gross, with GST). Money, so the key is the ledger's
 * `commission-payouts.settlement.view` like the GMV card, and only a platform admin acting as
 * themselves. Category ids only: the dashboard joins the names through `catalog`. The nil UUID is
 * goods whose category could not be read.
 */
export class ViewMarketplaceTopCategories extends UseCase<
  KpiInput,
  TopCategoriesAnswer,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-top-categories',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
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
  ): Promise<Result<TopCategoriesAnswer, AccessDenied>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const { deps } = this;
    const now = deps.clock.now();
    const period = resolvePeriod(input.period, marketDayOf(now, deps.zone.zoneOf(context.market)));
    const currency = deps.zone.currencyOf(context.market);
    try {
      const unit = await deps.unitOfWork.run(
        context.market,
        async () =>
          ok(
            await deps.reader.topCategories(
              context.market,
              currency,
              period.current,
              TOP_CATEGORIES_LIMIT,
            ),
          ),
        { readOnly: true },
      );
      if (!unit.ok) return err({ code: 'access.unavailable' });
      return ok({ period, currency, generatedAt: now, rows: unit.value.map(topCategoryRowOf) });
    } catch (error) {
      logger.warn({
        msg: 'reporting.top-categories.read-failed',
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
}
