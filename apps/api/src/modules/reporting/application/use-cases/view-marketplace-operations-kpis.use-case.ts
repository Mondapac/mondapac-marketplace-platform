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
  operationsDeltas,
  operationsOf,
  type DayTotals,
  type OperationsKpis,
  type KpiDeltas,
} from '../../domain/admin-kpi';
import type { ResolvedPeriod } from '../../domain/period';
import { readKpiRanges, type AdminKpiDependencies, type KpiInput } from '../admin-kpi-flow';

export interface OperationsPoint {
  readonly day: string;
  readonly ordersPaid: number;
  readonly ordersCancelled: number;
  readonly refunds: number;
}

export interface OperationsAnswer {
  readonly period: ResolvedPeriod;
  readonly generatedAt: Temporal.Instant;
  readonly refreshedAt: Temporal.Instant | null;
  readonly current: OperationsKpis;
  /** Sellers with at least one paid seller order in the period (market health). */
  readonly sellersWithOrders: number;
  readonly previous: OperationsKpis;
  readonly deltas: KpiDeltas<keyof OperationsKpis>;
  /** One point per day of the period, oldest first. */
  readonly series: readonly OperationsPoint[];
  /** The previous period, one point per day, for the dashed line. */
  readonly previousSeries: readonly OperationsPoint[];
}

const point = (row: DayTotals): OperationsPoint => ({
  day: row.day,
  ordersPaid: row.ordersPaid,
  ordersCancelled: row.ordersCancelled,
  refunds: row.refunds,
});

/**
 * `reporting.view-marketplace-operations-kpis` (dashboards upgrade phase 5): the marketplace's
 * order counts, cancel rate, on-time shipping and refund count for a period, against the period
 * before it. No money. Rule: the key `ordering.order.view`, and only a platform admin acting as
 * themselves. Read-only; the numbers are the daily rollups (up to a few minutes old, the answer
 * says when they were rebuilt).
 */
export class ViewMarketplaceOperationsKpis extends UseCase<
  KpiInput,
  OperationsAnswer,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-operations-kpis',
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
  ): Promise<Result<OperationsAnswer, AccessDenied>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const read = await readKpiRanges(this.deps, context, input);
    if (!read.ok) return read;
    const ranges = read.value;
    const current = operationsOf(ranges.current);
    const previous = operationsOf(ranges.previous);
    const sellers = await this.deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await this.deps.reader.sellersWithOrders(
            context.market,
            ranges.currency,
            ranges.period.current,
          ),
        ),
      { readOnly: true },
    );
    if (!sellers.ok) return err({ code: 'access.unavailable' });
    return ok({
      period: ranges.period,
      generatedAt: ranges.generatedAt,
      refreshedAt: ranges.refreshedAt,
      current,
      sellersWithOrders: sellers.value,
      previous,
      deltas: operationsDeltas(current, previous),
      series: ranges.current.map(point),
      previousSeries: ranges.previous.map(point),
    });
  }
}
