import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import {
  financeDeltas,
  financeOf,
  type DayTotals,
  type FinanceKpis,
  type KpiDeltas,
} from '../../domain/admin-kpi';
import type { ResolvedPeriod } from '../../domain/period';
import { readKpiRanges, type AdminKpiDependencies, type KpiInput } from '../admin-kpi-flow';

export interface FinancePoint {
  readonly day: string;
  readonly gmvWithTax: bigint;
  readonly gmvWithoutTax: bigint;
  readonly refundedWithTax: bigint;
}

export interface FinanceAnswer {
  readonly period: ResolvedPeriod;
  readonly currency: string;
  readonly generatedAt: Temporal.Instant;
  readonly refreshedAt: Temporal.Instant | null;
  readonly current: FinanceKpis;
  readonly previous: FinanceKpis;
  readonly deltas: KpiDeltas<keyof FinanceKpis>;
  readonly series: readonly FinancePoint[];
  readonly previousSeries: readonly FinancePoint[];
}

const point = (row: DayTotals): FinancePoint => ({
  day: row.day,
  gmvWithTax: row.goodsAmount,
  gmvWithoutTax: row.goodsAmount - row.goodsTax,
  refundedWithTax: -row.refundGoodsAmount,
});

/**
 * `reporting.view-marketplace-finance-kpis` (dashboards upgrade phase 5): GMV with and without
 * GST, refunded goods, the refund rate, net sales and the average order of a period, against the
 * period before it. Money, so the key is the ledger's `commission-payouts.settlement.view`
 * (design section 4: the finance permission), and only a platform admin acting as themselves.
 * Net revenue and take rate wait for a week of matching commission ledger (FE-066).
 */
export class ViewMarketplaceFinanceKpis extends UseCase<KpiInput, FinanceAnswer, AccessDenied> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-finance-kpis',
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
  ): Promise<Result<FinanceAnswer, AccessDenied>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const read = await readKpiRanges(this.deps, context, input);
    if (!read.ok) return read;
    const ranges = read.value;
    const current = financeOf(ranges.current);
    const previous = financeOf(ranges.previous);
    return ok({
      period: ranges.period,
      currency: ranges.currency,
      generatedAt: ranges.generatedAt,
      refreshedAt: ranges.refreshedAt,
      current,
      previous,
      deltas: financeDeltas(current, previous),
      series: ranges.current.map(point),
      previousSeries: ranges.previous.map(point),
    });
  }
}
