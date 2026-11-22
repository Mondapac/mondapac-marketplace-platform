import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SourceUnavailable } from '../ports/report-sources';
import {
  reconcileWindow,
  reconcileWindowAt,
  type ReconcileCounts,
  type ReportFactsDependencies,
} from '../report-facts-sync';

/**
 * `reporting.reconcile-facts`: the nightly reconcile (dashboards upgrade phase 3, design section
 * 4). Rule `system`. Reads again every seller order and refund of the last seven days from their
 * owners and records them, so an event that was lost, dead-lettered or came before a change it
 * does not name (an on-time promise that passed, a category moved) is put right.
 */
export class ReconcileReportFacts extends UseCase<
  Record<string, never>,
  ReconcileCounts,
  SourceUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.reconcile-facts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReportFactsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<ReconcileCounts, SourceUnavailable>> {
    return reconcileWindow(this.deps, context, reconcileWindowAt(this.deps.clock.now()));
  }
}
