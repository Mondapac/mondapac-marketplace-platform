import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { LedgerReportReader } from '../application/ports/ledger-report.reader';
import {
  LEDGER_REPORT_KINDS,
  type LedgerReportEntry,
  type LedgerReportKind,
  type LedgerReportPage,
  type LedgerReportWindow,
} from '../contracts/commission-payouts-reporting.facade';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** Only the columns reporting may see: ids and money (no order, line, rate or source). */
const SELECT = {
  id: true,
  sellerOrderId: true,
  sellerId: true,
  kind: true,
  amount: true,
  baseAmount: true,
  currency: true,
  occurredAt: true,
} as const;

interface Row {
  readonly id: string;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly kind: string;
  readonly amount: bigint;
  readonly baseAmount: bigint | null;
  readonly currency: string;
  readonly occurredAt: Date;
}

const toEntry = (row: Row): LedgerReportEntry => ({
  entryId: row.id as Id<'LedgerEntry'>,
  sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
  sellerId: row.sellerId as Id<'Seller'>,
  kind: row.kind as LedgerReportKind,
  amount: row.amount,
  // A cashback row never has a base; a commission row always has one (CHECK).
  baseAmount: row.kind === 'commission' || row.kind === 'refund-commission' ? row.baseAmount : null,
  currency: row.currency,
  occurredAt: Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime()),
});

/**
 * {@link LedgerReportReader} on `commission_payouts.ledger_entries`, with `marketId` in every
 * `where`. The seller orders' rows come by the `(market_id, seller_order_id)` index; the recorded
 * page walks the primary key in id order and filters the record time, which suits the one-off
 * history backfill (no index answers `recorded_at` across sellers).
 */
export class PrismaLedgerReportReader implements LedgerReportReader {
  constructor(private readonly prisma: PrismaService) {}

  async entriesOf(market: MarketContext, sellerOrderIds: readonly Id<'SellerOrder'>[]) {
    if (sellerOrderIds.length === 0) return [];
    const rows = await this.prisma.tx(market).commissionPayoutsLedgerEntry.findMany({
      where: {
        marketId: market.marketId,
        sellerOrderId: { in: [...sellerOrderIds] },
        kind: { in: [...LEDGER_REPORT_KINDS] },
      },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(toEntry);
  }

  async entriesRecorded(
    market: MarketContext,
    window: LedgerReportWindow,
    after: Id<'LedgerEntry'> | null,
    limit: number,
  ): Promise<LedgerReportPage> {
    const rows = await this.prisma.tx(market).commissionPayoutsLedgerEntry.findMany({
      where: {
        marketId: market.marketId,
        kind: { in: [...LEDGER_REPORT_KINDS] },
        recordedAt: {
          ...(window.from === null ? {} : { gte: toDate(window.from) }),
          lt: toDate(window.to),
        },
        ...(after === null ? {} : { id: { gt: after } }),
      },
      select: SELECT,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const entries = rows.slice(0, limit).map(toEntry);
    const last = entries[entries.length - 1];
    return { entries, next: rows.length > limit && last !== undefined ? last.entryId : null };
  }
}
