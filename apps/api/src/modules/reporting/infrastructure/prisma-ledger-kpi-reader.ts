import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { LEDGER_BACKFILL_KIND } from '../application/ports/backfill-progress-store';
import type {
  LedgerKpiReader,
  LedgerMatchFacts,
  LedgerRangeSums,
} from '../application/ports/ledger-kpi-reader';
import { EMPTY_LEDGER_SUMS, isLedgerFactKind, type LedgerKindSums } from '../domain/ledger';
import type { DayRange } from '../domain/period';
import { dateToDay, dayToDate } from './prisma-fact-store';

/**
 * {@link LedgerKpiReader}: the range sums are one grouped read of `reporting.daily_ledger` (the
 * primary key prefix `(market_id, market_day)`, or `(market_id, seller_id, market_day)` for one
 * seller); the readiness reads the window's paid seller orders by `(market_id, paid_day)` and its
 * commission facts by `(market_id, market_day)`. All inside reporting's own schema.
 */
export class PrismaLedgerKpiReader implements LedgerKpiReader {
  constructor(private readonly prisma: PrismaService) {}

  async rangeSums(
    market: MarketContext,
    currency: string,
    range: DayRange,
    sellerId: Id<'Seller'> | null,
  ): Promise<LedgerRangeSums> {
    const groups = await this.prisma.tx(market).reportingDailyLedger.groupBy({
      by: ['kind'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        currency,
        marketDay: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
        ...(sellerId === null ? {} : { sellerId }),
      },
      _sum: { amount: true, baseAmount: true },
      _max: { refreshedAt: true },
    });
    const sums: { -readonly [K in keyof LedgerKindSums]: LedgerKindSums[K] } = {
      ...EMPTY_LEDGER_SUMS,
    };
    let newest: Date | null = null;
    for (const group of groups) {
      if (!isLedgerFactKind(group.kind)) continue;
      sums[group.kind] = {
        amount: group._sum.amount ?? 0n,
        baseAmount: group._sum.baseAmount ?? 0n,
      };
      const at = group._max.refreshedAt;
      if (at !== null && (newest === null || at > newest)) newest = at;
    }
    return {
      sums,
      refreshedAt:
        newest === null ? null : Temporal.Instant.fromEpochMilliseconds(newest.getTime()),
    };
  }

  async matchFacts(
    market: MarketContext,
    currency: string,
    window: DayRange,
  ): Promise<LedgerMatchFacts> {
    const client = this.prisma.tx(market);
    const days = { gte: dayToDate(window.from), lte: dayToDate(window.to) };
    const [paid, commission] = await Promise.all([
      client.reportingSellerOrder.findMany({
        where: { marketId: market.marketId, currency, paidDay: days, goodsAmount: { gt: 0n } },
        select: { sellerOrderId: true, paidDay: true },
      }),
      client.reportingLedgerEntry.findMany({
        where: { marketId: market.marketId, currency, kind: 'commission', marketDay: days },
        select: { sellerOrderId: true, marketDay: true },
        distinct: ['sellerOrderId', 'marketDay'],
      }),
    ]);
    const paidIds = new Set(paid.map((row) => row.sellerOrderId));
    const others = [...new Set(commission.map((row) => row.sellerOrderId))].filter(
      (id) => !paidIds.has(id),
    );
    const unpaid =
      others.length === 0
        ? []
        : await client.reportingSellerOrder.findMany({
            where: { marketId: market.marketId, sellerOrderId: { in: others }, paidDay: null },
            select: { sellerOrderId: true },
          });
    return {
      paid: paid.map((row) => ({ sellerOrderId: row.sellerOrderId, day: dateToDay(row.paidDay!) })),
      commission: commission.map((row) => ({
        sellerOrderId: row.sellerOrderId,
        day: dateToDay(row.marketDay),
      })),
      knownUnpaid: new Set(unpaid.map((row) => row.sellerOrderId)),
    };
  }

  async backfillFinished(market: MarketContext): Promise<boolean> {
    const row = await this.prisma.tx(market).reportingBackfillProgress.findFirst({
      where: { marketId: market.marketId, kind: LEDGER_BACKFILL_KIND },
      select: { finishedAt: true },
    });
    return row !== null && row.finishedAt !== null;
  }
}
