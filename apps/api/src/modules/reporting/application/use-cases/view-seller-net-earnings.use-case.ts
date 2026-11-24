import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { sessionSellerOf } from '../../../../platform/work-queue/count-work-queue';
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../../../commission-payouts';
import { sellerNetEarningsOf, type SellerNetEarnings } from '../../domain/ledger';
import { marketDayOf } from '../../domain/facts';
import { isPeriodId, resolvePeriod, type DayRange } from '../../domain/period';
import {
  readNetFigures,
  type LedgerKpiDependencies,
  type NetFiguresFailure,
  type NetFiguresInput,
} from '../ledger-kpi-flow';

/**
 * A range of Market days, or a dashboard period (`today`, `7d`, `30d`, `month`) that the use case
 * turns into the Market's current range of that period (the one the KPI strip shows).
 */
export type SellerNetEarningsInput = NetFiguresInput | { readonly period: unknown };

export interface SellerNetEarningsAnswer {
  readonly range: DayRange;
  readonly currency: string;
  readonly timezone: string;
  readonly generatedAt: Temporal.Instant;
  readonly refreshedAt: Temporal.Instant | null;
  /** The Market's readiness only (FE-066): no day counts, which are every seller's. */
  readonly ready: boolean;
  /** Null until `ready`. */
  readonly earnings: SellerNetEarnings | null;
}

/**
 * `reporting.view-seller-net-earnings` (dashboards v2, phase 1, PR 4): the session seller's own net
 * earnings of a range of Market days, without GST, from its ledger facts. Rule: the key
 * `commission-payouts.earnings.view` (the seller's own ledger key), allowed while the seller is not
 * approved, as its ledger and payouts are. Always the session's own seller (`sessionSellerOf`),
 * never from input; a customer or an admin acting as themselves is `access.denied`. Null until the
 * Market's ledger has matched for a week; the seller sees only that flag.
 */
export class ViewSellerNetEarnings extends UseCase<
  SellerNetEarningsInput,
  SellerNetEarningsAnswer,
  NetFiguresFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-seller-net-earnings',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_EARNINGS_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LedgerKpiDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerNetEarningsInput,
  ): Promise<Result<SellerNetEarningsAnswer, NetFiguresFailure>> {
    const sellerId = sessionSellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    let range: NetFiguresInput;
    if (input !== null && typeof input === 'object' && 'period' in input) {
      if (!isPeriodId(input.period)) return err({ code: 'validation.failed' });
      const today = marketDayOf(this.deps.clock.now(), this.deps.zone.zoneOf(context.market));
      const { current } = resolvePeriod(input.period, today);
      range = { range: { from: current.from, to: current.to } };
    } else {
      range = input;
    }
    const read = await readNetFigures(this.deps, context, range, sellerId);
    if (!read.ok) return read;
    const figures = read.value;
    const ready = figures.readiness.ready;
    return ok({
      range: figures.range,
      currency: figures.currency,
      timezone: figures.timezone,
      generatedAt: figures.generatedAt,
      refreshedAt: figures.refreshedAt,
      ready,
      earnings: ready ? sellerNetEarningsOf(figures.sums, figures.currency) : null,
    });
  }
}
