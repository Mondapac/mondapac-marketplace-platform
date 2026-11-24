import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  backfillLedger,
  type LedgerBackfillCounts,
  type LedgerBackfillDependencies,
} from '../ledger-facts-sync';
import type { SourceUnavailable } from '../ports/report-sources';

/**
 * `reporting.backfill-ledger` (dashboards v2, phase 1, PR 4): writes the next pages of the ledger
 * history backfill. Rule `system`.
 */
export class BackfillLedger extends UseCase<
  Record<string, never>,
  LedgerBackfillCounts,
  SourceUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.backfill-ledger',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LedgerBackfillDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<LedgerBackfillCounts, SourceUnavailable>> {
    return backfillLedger(this.deps, context);
  }
}
