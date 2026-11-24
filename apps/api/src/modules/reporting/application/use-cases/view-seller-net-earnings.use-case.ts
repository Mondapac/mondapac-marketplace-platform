import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { sessionSellerOf } from '../../../../platform/work-queue/count-work-queue';
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../../../commission-payouts';
import { sellerNetEarningsOf, type SellerNetEarnings } from '../../domain/ledger';
import { parsePeriodQuery, type DayRange } from '../../domain/period';
import { resolveKpiPeriod } from '../admin-kpi-flow';
import { DEFAULT_PERIOD } from './view-seller-kpis.use-case';
import {
  readNetFigures,
  type LedgerKpiDependencies,
  type NetFiguresFailure,
  type NetFiguresInput,
} from '../ledger-kpi-flow';

/**
 * The query as it came, as the KPI strip's (`ViewSellerKpisInput`): a preset `period`
 * (`today`, `7d`, `30d`, `month`; default the strip's {@link DEFAULT_PERIOD}) that the use case
 * turns into the Market's current range of that period, or a custom range `from` and `to`
 * (Market days, both included, `period` absent or `custom`).
 */
export interface SellerNetEarningsQuery {
  readonly period?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
}

/** A range of Market days (the facade's shape), or the query of the dashboard. */
export type SellerNetEarningsInput = NetFiguresInput | SellerNetEarningsQuery;

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
    if (input !== null && typeof input === 'object' && 'range' in input) {
      range = input;
    } else {
      // The same rules as the KPI strip: shape first, then "ends by the Market's today".
      const query: SellerNetEarningsQuery | null | undefined = input;
      const asked = parsePeriodQuery(
        { period: query?.period, from: query?.from, to: query?.to },
        DEFAULT_PERIOD,
      );
      if (!asked.ok) return err({ code: 'validation.failed', fields: asked.error });
      const resolved = resolveKpiPeriod(this.deps, context, asked.value, this.deps.clock.now());
      if (!resolved.ok) return resolved;
      const { current } = resolved.value;
      range = { range: { from: current.from, to: current.to } };
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
