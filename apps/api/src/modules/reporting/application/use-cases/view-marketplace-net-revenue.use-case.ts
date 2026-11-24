import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import { netRevenueOf, type LedgerReadiness, type NetRevenue } from '../../domain/ledger';
import type { DayRange } from '../../domain/period';
import {
  readNetFigures,
  type LedgerKpiDependencies,
  type NetFiguresFailure,
  type NetFiguresInput,
} from '../ledger-kpi-flow';

export type { NetFiguresFailure, NetFiguresInput } from '../ledger-kpi-flow';

export interface NetRevenueAnswer {
  readonly range: DayRange;
  readonly currency: string;
  readonly timezone: string;
  readonly generatedAt: Temporal.Instant;
  readonly refreshedAt: Temporal.Instant | null;
  /** Whether a week of matching ledger is there (FE-066), with the days compared. */
  readonly readiness: LedgerReadiness;
  /** Null until `readiness.ready`: the figure is withheld, never shown early or as 0. */
  readonly netRevenue: NetRevenue | null;
}

/**
 * `reporting.view-marketplace-net-revenue` (dashboards v2, phase 1, PR 4): Mondapac's net revenue
 * of a range of Market days, without GST, from the ledger facts, with the readiness that gates it.
 * Money of the ledger, so the key is the ledger's `commission-payouts.settlement.view`, and only a
 * platform admin acting as themselves (as the finance KPIs). The figure is null until the ledger
 * has matched the sales facts for a week; the components with no source are `not-available`.
 */
export class ViewMarketplaceNetRevenue extends UseCase<
  NetFiguresInput,
  NetRevenueAnswer,
  NetFiguresFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-net-revenue',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LedgerKpiDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: NetFiguresInput,
  ): Promise<Result<NetRevenueAnswer, NetFiguresFailure>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const read = await readNetFigures(this.deps, context, input, null);
    if (!read.ok) return read;
    const figures = read.value;
    return ok({
      range: figures.range,
      currency: figures.currency,
      timezone: figures.timezone,
      generatedAt: figures.generatedAt,
      refreshedAt: figures.refreshedAt,
      readiness: figures.readiness,
      netRevenue: figures.readiness.ready ? netRevenueOf(figures.sums, figures.currency) : null,
    });
  }
}
