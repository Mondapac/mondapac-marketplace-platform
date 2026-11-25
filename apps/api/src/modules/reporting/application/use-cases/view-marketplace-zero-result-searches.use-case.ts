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
import { CATALOG_PRODUCT_VIEW } from '../../../catalog';
import type { ResolvedPeriod } from '../../domain/period';
import { zeroResultSearchesOf, type ZeroResultSearches } from '../../domain/zero-result-searches';
import { resolveKpiPeriod, type KpiFailure, type KpiInput } from '../admin-kpi-flow';
import type { MarketZone } from '../ports/market-zone';
import type { SearchStore } from '../ports/search-store';

const logger = new Logger('ViewMarketplaceZeroResultSearches');

export interface ZeroResultSearchesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: SearchStore;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

export interface ZeroResultSearchesAnswer {
  readonly period: ResolvedPeriod;
  readonly generatedAt: Temporal.Instant;
  readonly searches: ZeroResultSearches;
}

/**
 * `reporting.view-marketplace-zero-result-searches` (dashboards v2, phase 2): the top ten texts
 * the storefront search found nothing for in the period, from the nightly rows only (each a text
 * at least ten distinct signed-in customers searched on a day it found nothing; never a person).
 * Key `catalog.product.view` (what shoppers miss is a catalogue gap; the same key as the live
 * listings), a platform admin acting as themselves. `not-enough-data` when no text qualifies. One
 * read-only unit (ADR-0025).
 */
export class ViewMarketplaceZeroResultSearches extends UseCase<
  KpiInput,
  ZeroResultSearchesAnswer,
  KpiFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-zero-result-searches',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ZeroResultSearchesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: KpiInput,
  ): Promise<Result<ZeroResultSearchesAnswer, KpiFailure>> {
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
              this.deps.store.rows(market, period.current),
              this.deps.store.recordedDays(market, period.current),
            ]),
          ),
        { readOnly: true },
      );
      if (!unit.ok) return err({ code: 'access.unavailable' });
      const [rows, recorded] = unit.value;
      return ok({
        period,
        generatedAt: now,
        searches: zeroResultSearchesOf(rows, recorded, period.current),
      });
    } catch (error) {
      logger.warn({
        msg: 'reporting.zero-result-searches.read-failed',
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
