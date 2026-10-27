import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { DisputeRecord, DisputeStore } from '../application/ports/dispute-store';
import type { DisputeOutcome, DisputeReason, DisputeState, DisputeStatus } from '../domain/dispute';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const optionalDate = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const optionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

interface DisputeRow {
  id: string;
  providerDisputeId: string;
  orderId: string;
  paymentIntentRef: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  reason: string;
  evidenceDueBy: Date | null;
  fundsWithdrawn: boolean;
  fundsWithdrawnAt: Date | null;
  fundsReinstated: boolean;
  fundsReinstatedAt: Date | null;
  outcome: string | null;
  openedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastReadAt: Date;
  version: number;
}

const toRecord = (row: DisputeRow): DisputeRecord => ({
  id: row.id,
  providerDisputeId: row.providerDisputeId,
  orderId: row.orderId,
  paymentIntentRef: row.paymentIntentRef,
  amountMinor: row.amountMinor,
  currency: row.currency,
  // The CHECKs keep these to the known values.
  status: row.status as DisputeStatus,
  reason: row.reason as DisputeReason,
  evidenceDueBy: optionalInstant(row.evidenceDueBy),
  fundsWithdrawn: row.fundsWithdrawn,
  fundsWithdrawnAt: optionalInstant(row.fundsWithdrawnAt),
  fundsReinstated: row.fundsReinstated,
  fundsReinstatedAt: optionalInstant(row.fundsReinstatedAt),
  outcome: row.outcome as DisputeOutcome | null,
  openedAt: toInstant(row.openedAt),
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
  lastReadAt: toInstant(row.lastReadAt),
  version: row.version,
});

const stateData = (state: DisputeState) => ({
  status: state.status,
  reason: state.reason,
  evidenceDueBy: optionalDate(state.evidenceDueBy),
  fundsWithdrawn: state.fundsWithdrawn,
  fundsWithdrawnAt: optionalDate(state.fundsWithdrawnAt),
  fundsReinstated: state.fundsReinstated,
  fundsReinstatedAt: optionalDate(state.fundsReinstatedAt),
  outcome: state.outcome,
});

/** `payments.disputes` through the unit of work's transaction. */
export class PrismaDisputeStore implements DisputeStore {
  constructor(private readonly prisma: PrismaService) {}

  async findByRef(market: MarketContext, providerDisputeId: string) {
    const row = await this.prisma.tx(market).paymentsDispute.findFirst({
      where: { marketId: market.marketId, providerDisputeId },
    });
    return row === null ? null : toRecord(row);
  }

  async insert(market: MarketContext, record: DisputeRecord): Promise<'inserted' | 'conflict'> {
    const created = await this.prisma.tx(market).paymentsDispute.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          id: record.id,
          providerDisputeId: record.providerDisputeId,
          orderId: record.orderId,
          paymentIntentRef: record.paymentIntentRef,
          amountMinor: record.amountMinor,
          currency: record.currency,
          ...stateData(record),
          openedAt: toDate(record.openedAt),
          createdAt: toDate(record.createdAt),
          updatedAt: toDate(record.updatedAt),
          lastReadAt: toDate(record.lastReadAt),
          version: record.version,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'inserted' : 'conflict';
  }

  async update(
    market: MarketContext,
    id: string,
    expectedVersion: number,
    next: DisputeState,
    readAt: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).paymentsDispute.updateMany({
      where: {
        marketId: market.marketId,
        id,
        version: expectedVersion,
        lastReadAt: { lte: toDate(readAt) },
      },
      data: {
        ...stateData(next),
        updatedAt: toDate(readAt),
        lastReadAt: toDate(readAt),
        version: expectedVersion + 1,
      },
    });
    return updated.count === 1;
  }

  async findMany(market: MarketContext, ids: readonly string[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).paymentsDispute.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRecord);
  }
}
