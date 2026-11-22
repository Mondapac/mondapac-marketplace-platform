import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { sessionSellerOf } from '../../../../platform/work-queue/count-work-queue';
import { ORDERING_SELLER_ORDER_VIEW } from '../../../ordering';
import { marketDayOf } from '../../domain/facts';
import { isPeriodId, resolvePeriod, type PeriodId, type ResolvedPeriod } from '../../domain/period';
import { buildSellerKpis, type SellerKpis } from '../../domain/seller-kpis';
import type { MarketZone } from '../ports/market-zone';
import type { SellerKpiReader } from '../ports/seller-kpi-reader';

const logger = new Logger('ViewSellerKpis');

export interface ViewSellerKpisDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: SellerKpiReader;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

export interface ViewSellerKpisInput {
  readonly period?: unknown;
}

export interface SellerKpiAnswer {
  readonly period: ResolvedPeriod;
  readonly timezone: string;
  readonly currency: string;
  readonly kpis: SellerKpis;
}

export type ViewSellerKpisFailure = AccessDenied | { readonly code: 'validation.failed' };

export const DEFAULT_PERIOD: PeriodId = '30d';

/**
 * `reporting.view-seller-kpis` (dashboards upgrade, phase 6, PR 16): the seller's own sales,
 * orders, refunds, shipping and category figures for a period against the one before it, from the
 * daily rollups. Rule: the key `ordering.seller-order.view` (the figures are sums of the seller's
 * own paid orders), denied while the seller is not approved. Always the session's own seller: it
 * comes from the session (`sessionSellerOf`), never from input, and every read is limited to it.
 * A customer or an admin acting as themselves is `access.denied`; Login as Seller reads as the
 * seller does. Days are the Market's (ADR-0005). One read-only unit.
 */
export class ViewSellerKpis extends UseCase<
  ViewSellerKpisInput,
  SellerKpiAnswer,
  ViewSellerKpisFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-seller-kpis',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewSellerKpisDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewSellerKpisInput,
  ): Promise<Result<SellerKpiAnswer, ViewSellerKpisFailure>> {
    const sellerId = sessionSellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const asked = input?.period ?? DEFAULT_PERIOD;
    if (!isPeriodId(asked)) return err({ code: 'validation.failed' });
    const { market } = context;
    const timezone = this.deps.zone.zoneOf(market);
    const currency = this.deps.zone.currencyOf(market);
    const period = resolvePeriod(asked, marketDayOf(this.deps.clock.now(), timezone));
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await this.deps.reader.read(
              market,
              sellerId,
              currency,
              period.current,
              period.previous,
            ),
          ),
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'access.unavailable' });
      return ok({
        period,
        timezone,
        currency,
        kpis: buildSellerKpis(period, read.value.daily, read.value.categories),
      });
    } catch (error) {
      // The class only: a store error may carry a statement or a value.
      logger.error({
        msg: 'reporting.seller-kpis.read-failed',
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
  }
}
