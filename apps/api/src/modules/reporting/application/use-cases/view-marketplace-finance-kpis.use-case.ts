import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import {
  financeDeltas,
  financeOf,
  MIN_MONEY_BASE,
  rateDelta,
  type DayTotals,
  type FinanceKpis,
  type KpiDeltas,
} from '../../domain/admin-kpi';
import { takeRateOf, type TakeRate } from '../../domain/admin-health';
import {
  netRevenueOf,
  type LedgerKindSums,
  type LedgerReadiness,
  type NetRevenue,
} from '../../domain/ledger';
import { delta, type Delta, type ResolvedPeriod } from '../../domain/period';
import {
  readKpiRanges,
  type AdminKpiDependencies,
  type KpiFailure,
  type KpiInput,
} from '../admin-kpi-flow';
import { readLedgerPeriod } from '../ledger-kpi-flow';
import type { LedgerKpiReader } from '../ports/ledger-kpi-reader';

export interface FinancePoint {
  readonly day: string;
  readonly gmvWithTax: bigint;
  readonly gmvWithoutTax: bigint;
  readonly refundedWithTax: bigint;
}

/**
 * Mondapac's net revenue and take rate of the period and the period before it (dashboards v2,
 * phase 1, PR 6), behind the "one week of matching ledger" readiness (FE-066): every figure is
 * null until `readiness.ready`. A net revenue whose total is `partial` carries its components and
 * `missing`, never a total; its take rate is `partial`, from the available components only.
 */
export interface FinanceNet {
  readonly readiness: LedgerReadiness;
  readonly current: NetRevenue | null;
  readonly previous: NetRevenue | null;
  /** Net revenue ÷ GMV without GST of the same range; null until ready. */
  readonly takeRate: { readonly current: TakeRate | null; readonly previous: TakeRate | null };
  readonly deltas: {
    /** The commission component (net of refunds). */
    readonly commission: Delta;
    /** The total: `na` unless both periods are complete. */
    readonly total: Delta;
    /** Basis points of difference; `na` unless both rates have the same status and basis. */
    readonly takeRateBp: Delta;
  };
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
  /** Net revenue and take rate; null when this secondary read failed (the GMV numbers stay). */
  readonly net: FinanceNet | null;
}

export interface FinanceKpiDependencies extends AdminKpiDependencies {
  readonly ledger: LedgerKpiReader;
}

const NA: Delta = { value: 0, direction: 'flat', state: 'na' };

const sameRateKind = (a: TakeRate, b: TakeRate): boolean =>
  a.status === b.status &&
  (a.status !== 'partial' || (b.status === 'partial' && a.basis.join(',') === b.basis.join(',')));

/** The net figures of both ranges from their ledger sums and GMV, withheld until ready. */
export function financeNetOf(
  readiness: LedgerReadiness,
  sums: { readonly current: LedgerKindSums; readonly previous: LedgerKindSums },
  gmv: { readonly current: FinanceKpis; readonly previous: FinanceKpis },
  currency: string,
): FinanceNet {
  if (!readiness.ready) {
    return {
      readiness,
      current: null,
      previous: null,
      takeRate: { current: null, previous: null },
      deltas: { commission: NA, total: NA, takeRateBp: NA },
    };
  }
  const current = netRevenueOf(sums.current, currency);
  const previous = netRevenueOf(sums.previous, currency);
  const rateNow = takeRateOf(current, gmv.current.gmvWithoutTax);
  const rateBefore = takeRateOf(previous, gmv.previous.gmvWithoutTax);
  const commissionOf = (net: NetRevenue): bigint =>
    net.components.commission.status === 'available' ? net.components.commission.amount : 0n;
  return {
    readiness,
    current,
    previous,
    takeRate: { current: rateNow, previous: rateBefore },
    deltas: {
      commission:
        current.components.commission.status === 'available' &&
        previous.components.commission.status === 'available'
          ? delta(commissionOf(current), commissionOf(previous), MIN_MONEY_BASE)
          : NA,
      total:
        current.total.status === 'complete' && previous.total.status === 'complete'
          ? delta(current.total.amount, previous.total.amount, MIN_MONEY_BASE)
          : NA,
      takeRateBp:
        rateNow.status !== 'no-sales' &&
        rateBefore.status !== 'no-sales' &&
        sameRateKind(rateNow, rateBefore)
          ? rateDelta(rateNow.rateBp, rateBefore.rateBp, gmv.previous.gmvWithTax >= MIN_MONEY_BASE)
          : NA,
    },
  };
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
 * Net revenue and take rate (`net`, dashboards v2 PR 6) wait for a week of matching commission
 * ledger (FE-066), read from the ledger rollup in a second read-only unit.
 */
export class ViewMarketplaceFinanceKpis extends UseCase<KpiInput, FinanceAnswer, KpiFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-finance-kpis',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FinanceKpiDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: KpiInput,
  ): Promise<Result<FinanceAnswer, KpiFailure>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const read = await readKpiRanges(this.deps, context, input);
    if (!read.ok) return read;
    const ranges = read.value;
    const current = financeOf(ranges.current);
    const previous = financeOf(ranges.previous);
    // A second unit, like the operations answer's sellers count: when it fails only the net
    // figures go missing (null), never GMV.
    const ledger = await readLedgerPeriod(
      { unitOfWork: this.deps.unitOfWork, reader: this.deps.ledger },
      context,
      ranges.currency,
      ranges.period.current.to,
      ranges.period,
    );
    const net =
      ledger === null
        ? null
        : financeNetOf(ledger.readiness, ledger, { current, previous }, ranges.currency);
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
      net,
    });
  }
}
