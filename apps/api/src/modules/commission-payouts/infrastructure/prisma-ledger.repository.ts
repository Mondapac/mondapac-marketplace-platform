import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { LedgerPage, LedgerRepository } from '../application/ports/ledger.repository';
import { LEDGER_KINDS, type LedgerEntry, type LedgerKind } from '../domain/ledger';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly sellerId: string;
  readonly orderId: string;
  readonly sellerOrderId: string;
  readonly orderLineId: string | null;
  readonly kind: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly rateBps: number | null;
  readonly baseAmount: bigint | null;
  readonly sourceId: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
}

const toEntry = (row: Row): LedgerEntry => ({
  id: row.id as Id<'LedgerEntry'>,
  sellerId: row.sellerId as Id<'Seller'>,
  orderId: row.orderId as Id<'Order'>,
  sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
  orderLineId: row.orderLineId as Id<'OrderLine'> | null,
  kind: row.kind as LedgerKind,
  amount: money(row.amount, row.currency),
  rateBps: row.rateBps,
  baseAmount: row.baseAmount,
  sourceId: row.sourceId as Id<'Refund'> | Id<'Dispute'> | null,
  occurredAt: toInstant(row.occurredAt),
  recordedAt: toInstant(row.recordedAt),
});

/** Rows recorded before the cursor, newest first: `(recorded_at, id) < (cursor)`. */
const afterCursor = (page: LedgerPage) =>
  page.after === null
    ? {}
    : {
        OR: [
          { recordedAt: { lt: toDate(page.after.recordedAt) } },
          { recordedAt: toDate(page.after.recordedAt), id: { lt: page.after.id } },
        ],
      };

/**
 * {@link LedgerRepository} on `commission_payouts.ledger_entries`, scoped by `marketId` in every
 * `where`. It only reads and inserts; the table refuses anything else.
 */
export class PrismaLedgerRepository implements LedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async hasSellerOrder(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    const row = await this.prisma.tx(market).commissionPayoutsLedgerEntry.findFirst({
      where: { marketId: market.marketId, sellerOrderId },
      select: { id: true },
    });
    return row !== null;
  }

  async listSellerOrder(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    const rows = await this.prisma.tx(market).commissionPayoutsLedgerEntry.findMany({
      where: { marketId: market.marketId, sellerOrderId },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toEntry);
  }

  async append(market: MarketContext, entries: readonly LedgerEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const created = await this.prisma.tx(market).commissionPayoutsLedgerEntry.createMany({
      data: entries.map((entry) => ({
        id: entry.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: entry.sellerId,
        orderId: entry.orderId,
        sellerOrderId: entry.sellerOrderId,
        orderLineId: entry.orderLineId,
        kind: entry.kind,
        amount: entry.amount.amount,
        currency: entry.amount.currency,
        rateBps: entry.rateBps,
        baseAmount: entry.baseAmount,
        sourceId: entry.sourceId,
        occurredAt: toDate(entry.occurredAt),
        recordedAt: toDate(entry.recordedAt),
      })),
      skipDuplicates: true,
    });
    return created.count;
  }

  async list(market: MarketContext, sellerId: Id<'Seller'>, page: LedgerPage) {
    const rows = await this.prisma.tx(market).commissionPayoutsLedgerEntry.findMany({
      where: { marketId: market.marketId, sellerId, ...afterCursor(page) },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map(toEntry);
  }

  async sums(market: MarketContext, sellerId: Id<'Seller'>) {
    const groups = await this.prisma.tx(market).commissionPayoutsLedgerEntry.groupBy({
      by: ['currency', 'kind'],
      where: { marketId: market.marketId, sellerId },
      _sum: { amount: true },
    });
    return groups
      .filter((group) => (LEDGER_KINDS as readonly string[]).includes(group.kind))
      .map((group) => ({
        currency: group.currency,
        kind: group.kind as LedgerKind,
        amount: group._sum.amount ?? 0n,
      }));
  }
}
