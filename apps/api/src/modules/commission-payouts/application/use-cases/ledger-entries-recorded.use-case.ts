import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  LedgerReportFailure,
  LedgerReportPage,
} from '../../contracts/commission-payouts-reporting.facade';
import {
  ledgerEntriesRecorded,
  type LedgerEntriesRecordedInput,
  type LedgerReportDependencies,
} from '../ledger-report-flow';

/**
 * `commission-payouts.ledger-entries-recorded` (dashboards v2, phase 1, PR 4): the commission and
 * seller-cashback rows recorded in a window, keyset-paged by entry id, for reporting's ledger
 * history backfill. Rule `system`. Ids and money only.
 */
export class LedgerEntriesRecordedQuery extends UseCase<
  LedgerEntriesRecordedInput,
  LedgerReportPage,
  LedgerReportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.ledger-entries-recorded',
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
    input: LedgerEntriesRecordedInput,
  ): Promise<Result<LedgerReportPage, LedgerReportFailure>> {
    return ledgerEntriesRecorded(this.deps, context, input);
  }
}
