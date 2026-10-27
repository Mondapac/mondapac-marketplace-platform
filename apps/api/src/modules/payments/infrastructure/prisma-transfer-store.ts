import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  TransferChange,
  TransferRecord,
  TransferStore,
} from '../application/ports/transfer-store';
import type { TransferFailureCode, TransferState } from '../domain/transfer';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const optionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);
const optionalDate = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);

interface TransferRow {
  id: string;
  instructionKey: string;
  sellerId: string | null;
  accountRef: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  reference: string | null;
  state: string;
  providerTransferRef: string | null;
  failureCode: string | null;
  reversedMinor: bigint;
  sendCount: number;
  leaseUntil: Date | null;
  abandonedAt: Date | null;
  fenceBreachedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const toRecord = (row: TransferRow): TransferRecord => ({
  id: row.id,
  instructionKey: row.instructionKey,
  sellerId: row.sellerId,
  accountRef: row.accountRef,
  amountMinor: row.amountMinor,
  currency: row.currency,
  reference: row.reference,
  // The CHECKs keep these to the known values.
  state: row.state as TransferState,
  providerTransferRef: row.providerTransferRef,
  failureCode: row.failureCode as TransferFailureCode | null,
  reversedMinor: row.reversedMinor,
  sendCount: row.sendCount === 1 ? 1 : 0,
  leaseUntil: optionalInstant(row.leaseUntil),
  abandonedAt: optionalInstant(row.abandonedAt),
  fenceBreachedAt: optionalInstant(row.fenceBreachedAt),
  executedAt: optionalInstant(row.executedAt),
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
  version: row.version,
});

/** `payments.transfer_executions` through the unit of work's transaction. */
export class PrismaTransferStore implements TransferStore {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(market: MarketContext, instructionKey: string) {
    const row = await this.prisma.tx(market).paymentsTransferExecution.findFirst({
      where: { marketId: market.marketId, instructionKey },
    });
    return row === null ? null : toRecord(row);
  }

  async findManyByKey(market: MarketContext, instructionKeys: readonly string[]) {
    if (instructionKeys.length === 0) return [];
    const rows = await this.prisma.tx(market).paymentsTransferExecution.findMany({
      where: { marketId: market.marketId, instructionKey: { in: [...instructionKeys] } },
    });
    return rows.map(toRecord);
  }

  async insert(market: MarketContext, record: TransferRecord): Promise<'inserted' | 'conflict'> {
    const created = await this.prisma.tx(market).paymentsTransferExecution.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          id: record.id,
          instructionKey: record.instructionKey,
          sellerId: record.sellerId,
          accountRef: record.accountRef,
          amountMinor: record.amountMinor,
          currency: record.currency,
          reference: record.reference,
          state: record.state,
          providerTransferRef: record.providerTransferRef,
          failureCode: record.failureCode,
          reversedMinor: record.reversedMinor,
          sendCount: record.sendCount,
          leaseUntil: optionalDate(record.leaseUntil),
          abandonedAt: optionalDate(record.abandonedAt),
          fenceBreachedAt: optionalDate(record.fenceBreachedAt),
          executedAt: optionalDate(record.executedAt),
          createdAt: toDate(record.createdAt),
          updatedAt: toDate(record.updatedAt),
          version: record.version,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'inserted' : 'conflict';
  }

  insertTombstone(
    market: MarketContext,
    tombstone: { id: string; instructionKey: string; at: Temporal.Instant },
  ): Promise<'inserted' | 'conflict'> {
    return this.insert(market, {
      id: tombstone.id,
      instructionKey: tombstone.instructionKey,
      sellerId: null,
      accountRef: null,
      amountMinor: null,
      currency: null,
      reference: null,
      state: 'abandoned',
      providerTransferRef: null,
      failureCode: null,
      reversedMinor: 0n,
      sendCount: 0,
      leaseUntil: null,
      abandonedAt: tombstone.at,
      fenceBreachedAt: null,
      executedAt: null,
      createdAt: tombstone.at,
      updatedAt: tombstone.at,
      version: 1,
    });
  }

  async change(
    market: MarketContext,
    id: string,
    from: { state: TransferState; version: number },
    change: TransferChange,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).paymentsTransferExecution.updateMany({
      where: { marketId: market.marketId, id, state: from.state, version: from.version },
      data: {
        state: change.state,
        ...(change.providerTransferRef === undefined
          ? {}
          : { providerTransferRef: change.providerTransferRef }),
        ...(change.failureCode === undefined ? {} : { failureCode: change.failureCode }),
        ...(change.executedAt === undefined ? {} : { executedAt: toDate(change.executedAt) }),
        ...(change.abandonedAt === undefined ? {} : { abandonedAt: toDate(change.abandonedAt) }),
        ...(change.fenceBreachedAt === undefined
          ? {}
          : { fenceBreachedAt: toDate(change.fenceBreachedAt) }),
        ...(change.reversedMinor === undefined ? {} : { reversedMinor: change.reversedMinor }),
        updatedAt: toDate(at),
        version: from.version + 1,
      },
    });
    return updated.count === 1;
  }

  async sendingPastLease(market: MarketContext, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).paymentsTransferExecution.findMany({
      where: { marketId: market.marketId, state: 'sending', leaseUntil: { lte: toDate(now) } },
      orderBy: [{ leaseUntil: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  async executedTotal(
    market: MarketContext,
    currency: string,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<bigint> {
    const total = await this.prisma.tx(market).paymentsTransferExecution.aggregate({
      _sum: { amountMinor: true },
      where: {
        marketId: market.marketId,
        state: 'executed',
        currency,
        executedAt: { gte: toDate(from), lt: toDate(to) },
      },
    });
    return total._sum.amountMinor ?? 0n;
  }
}
