import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { LedgerEntriesRecordedQuery } from '../application/use-cases/ledger-entries-recorded.use-case';
import type { LedgerReportEntriesQuery } from '../application/use-cases/ledger-report-entries.use-case';
import type {
  CommissionPayoutsReportingFacade,
  LedgerReportWindow,
} from '../contracts/commission-payouts-reporting.facade';

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class CommissionPayoutsReportingFacadeImplementation implements CommissionPayoutsReportingFacade {
  constructor(
    private readonly entries: LedgerReportEntriesQuery,
    private readonly recorded: LedgerEntriesRecordedQuery,
  ) {}

  ledgerReportEntries(
    context: CallContext,
    request: { readonly sellerOrderIds: readonly Id<'SellerOrder'>[] },
  ) {
    return this.entries.execute(context, request);
  }

  ledgerEntriesRecorded(
    context: CallContext,
    request: {
      readonly window: LedgerReportWindow;
      readonly after: string | null;
      readonly limit: number;
    },
  ) {
    return this.recorded.execute(context, request);
  }
}
