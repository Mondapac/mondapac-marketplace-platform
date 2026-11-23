import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  LedgerReportEntry,
  LedgerReportFailure,
} from '../../contracts/commission-payouts-reporting.facade';
import {
  ledgerReportEntries,
  type LedgerReportDependencies,
  type LedgerReportEntriesInput,
} from '../ledger-report-flow';

/**
 * `commission-payouts.ledger-report-entries` (dashboards v2, phase 1, PR 4): the commission and
 * seller-cashback rows of some seller orders, for reporting's ledger event worker. Rule `system`.
 * Ids and money only.
 */
export class LedgerReportEntriesQuery extends UseCase<
  LedgerReportEntriesInput,
  readonly LedgerReportEntry[],
  LedgerReportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.ledger-report-entries',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LedgerReportDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: LedgerReportEntriesInput,
  ): Promise<Result<readonly LedgerReportEntry[], LedgerReportFailure>> {
    return ledgerReportEntries(this.deps, context, input);
  }
}
