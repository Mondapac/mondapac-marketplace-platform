import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  ReportingLedgerConflict,
  type LedgerFactStore,
} from '../application/ports/ledger-fact-store';
import {
  isLedgerFactKind,
  sameLedgerFact,
  type LedgerDayTotals,
  type LedgerFact,
} from '../domain/ledger';
import type { SellerDay } from '../domain/rollup';
import { dateToDay, dayToDate } from './prisma-fact-store';

interface Row {
  readonly entryId: string;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly kind: string;
  readonly currency: string;
  readonly amount: bigint;
  readonly baseAmount: bigint | null;
  readonly occurredAt: Date;
  readonly marketDay: Date;
}

const toFact = (row: Row): LedgerFact => {
  if (!isLedgerFactKind(row.kind)) throw new TypeError(`reporting.ledger_entries: ${row.kind}`);
  return {
    entryId: row.entryId as Id<'LedgerEntry'>,
    sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
    sellerId: row.sellerId as Id<'Seller'>,
    kind: row.kind,
    currency: row.currency,
    amount: row.amount,
    baseAmount: row.baseAmount,
    occurredAt: Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime()),
    marketDay: dateToDay(row.marketDay),
  };
};

const SELECT = {
  entryId: true,
  sellerOrderId: true,
  sellerId: true,
  kind: true,
  currency: true,
  amount: true,
  baseAmount: true,
  occurredAt: true,
  marketDay: true,
} as const;

/**
 * {@link LedgerFactStore} on `reporting.ledger_entries` and `reporting.daily_ledger`, through
 * `PrismaService.tx(market)` with `marketId` in every `where`. The facts are insert-only (no UPDATE
 * grant); a seller day of the rollup is replaced as a whole (no UPDATE grant either).
 */
export class PrismaLedgerFactStore implements LedgerFactStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly now: () => Temporal.Instant,
  ) {}

  async putEntries(market: MarketContext, facts: readonly LedgerFact[]): Promise<void> {
    if (facts.length === 0) return;
    const client = this.prisma.tx(market);
    const recordedAt = new Date(this.now().epochMilliseconds);
    // Entry id order, so two units insert in one order.
    const sorted = [...facts].sort((a, b) => (a.entryId < b.entryId ? -1 : 1));
    await client.reportingLedgerEntry.createMany({
      data: sorted.map((fact) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        entryId: fact.entryId,
        sellerOrderId: fact.sellerOrderId,
        sellerId: fact.sellerId,
        kind: fact.kind,
        currency: fact.currency,
        amount: fact.amount,
        baseAmount: fact.baseAmount,
        occurredAt: new Date(fact.occurredAt.epochMilliseconds),
        marketDay: dayToDate(fact.marketDay),
        recordedAt,
      })),
      skipDuplicates: true,
    });
    // Every fact is now stored: the ones just written and the ones already there must be the
    // facts read (Hassan: a changed ledger row is a bug upstream, never overwritten).
    const stored = await client.reportingLedgerEntry.findMany({
      where: { marketId: market.marketId, entryId: { in: sorted.map((fact) => fact.entryId) } },
      select: SELECT,
    });
    const byId = new Map(stored.map((row) => [row.entryId, toFact(row)] as const));
    for (const fact of sorted) {
      const found = byId.get(fact.entryId);
      if (found === undefined || !sameLedgerFact(found, fact)) {
        throw new ReportingLedgerConflict(fact.entryId);
      }
    }
  }

  async loadSellerDay(market: MarketContext, key: SellerDay): Promise<readonly LedgerFact[]> {
    const rows = await this.prisma.tx(market).reportingLedgerEntry.findMany({
      where: {
        marketId: market.marketId,
        marketDay: dayToDate(key.marketDay),
        sellerId: key.sellerId,
      },
      select: SELECT,
      orderBy: { entryId: 'asc' },
    });
    return rows.map(toFact);
  }

  async replaceSellerDay(
    market: MarketContext,
    key: SellerDay,
    rows: readonly LedgerDayTotals[],
  ): Promise<void> {
    const client = this.prisma.tx(market);
    const where = {
      marketId: market.marketId,
      marketDay: dayToDate(key.marketDay),
      sellerId: key.sellerId,
    };
    await client.reportingDailyLedger.deleteMany({ where });
    if (rows.length === 0) return;
    const refreshedAt = new Date(this.now().epochMilliseconds);
    await client.reportingDailyLedger.createMany({
      data: rows.map((row) => ({
        ...where,
        tenantId: market.tenantId,
        currency: row.currency,
        kind: row.kind,
        entries: row.entries,
        sellerOrders: row.sellerOrders,
        amount: row.amount,
        baseAmount: row.baseAmount,
        refreshedAt,
      })),
    });
  }
}
