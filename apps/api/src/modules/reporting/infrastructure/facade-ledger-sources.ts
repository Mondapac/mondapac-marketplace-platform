import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CommissionPayoutsReportingFacade, LedgerReportEntry } from '../../commission-payouts';
import type { LedgerSourceEntry, LedgerSources } from '../application/ports/ledger-sources';
import type {
  SourcePage,
  SourceUnavailable,
  SourceWindow,
} from '../application/ports/report-sources';
import { isLedgerFactKind } from '../domain/ledger';

const unavailable = (cause: string): SourceUnavailable => ({
  code: 'reporting.source-unavailable',
  cause,
});

/** A row of a kind reporting does not know is refused (the facade answers only the four). */
const toSource = (entry: LedgerReportEntry): LedgerSourceEntry => {
  if (!isLedgerFactKind(entry.kind)) throw new RangeError('reporting: unknown ledger kind');
  return {
    entryId: entry.entryId,
    sellerOrderId: entry.sellerOrderId,
    sellerId: entry.sellerId,
    kind: entry.kind,
    amount: entry.amount,
    baseAmount: entry.baseAmount,
    currency: entry.currency,
    occurredAt: entry.occurredAt,
  };
};

/** {@link LedgerSources} on commission-payouts' reporting facade (rule `system`). */
export class FacadeLedgerSources implements LedgerSources {
  constructor(private readonly ledger: CommissionPayoutsReportingFacade) {}

  async entriesOf(
    context: CallContext,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<Result<readonly LedgerSourceEntry[], SourceUnavailable>> {
    const read = await this.ledger.ledgerReportEntries(context, { sellerOrderIds });
    if (!read.ok) return err(unavailable(`commission-payouts ${read.error.code}`));
    return ok(read.value.map(toSource));
  }

  async entriesRecorded(
    context: CallContext,
    window: SourceWindow,
    after: string | null,
    limit: number,
  ): Promise<Result<SourcePage<LedgerSourceEntry>, SourceUnavailable>> {
    const read = await this.ledger.ledgerEntriesRecorded(context, { window, after, limit });
    if (!read.ok) return err(unavailable(`commission-payouts ${read.error.code}`));
    return ok({ items: read.value.entries.map(toSource), next: read.value.next });
  }
}
