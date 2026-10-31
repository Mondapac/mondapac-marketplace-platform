import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CreditRepository } from '../application/ports/credit.repository';
import type { CreditKind, CreditRecord, CreditSourceKind, CreditStatus } from '../domain/credit';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly promotionId: string;
  readonly kind: string;
  readonly recipientAccountId: string;
  readonly orderId: string | null;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly walletJournalId: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

const toRecord = (row: Row): CreditRecord => ({
  id: row.id as Id<'PromotionCredit'>,
  promotionId: row.promotionId as Id<'Promotion'>,
  kind: row.kind as CreditKind,
  recipientAccountId: row.recipientAccountId as Id<'Account'>,
  orderId: row.orderId as Id<'Order'> | null,
  sourceKind: row.sourceKind as CreditSourceKind,
  sourceId: row.sourceId,
  amountMinor: row.amountMinor,
  currency: row.currency,
  status: row.status as CreditStatus,
  failureCode: row.failureCode,
  walletJournalId: row.walletJournalId,
  idempotencyKey: row.idempotencyKey,
  createdAt: fromDate(row.createdAt),
  settledAt: row.settledAt === null ? null : fromDate(row.settledAt),
});

/** {@link CreditRepository} on `promotions.credit_issuances`, scoped by `marketId`. */
export class PrismaCreditRepository implements CreditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, record: CreditRecord): Promise<'inserted' | 'duplicate'> {
    // ON CONFLICT DO NOTHING: a repeated event does not abort the unit's transaction.
    const created = await this.prisma.tx(market).promotionsCreditIssuance.createMany({
      data: [
        {
          id: record.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          promotionId: record.promotionId,
          kind: record.kind,
          recipientAccountId: record.recipientAccountId,
          orderId: record.orderId,
          sourceKind: record.sourceKind,
          sourceId: record.sourceId,
          amountMinor: record.amountMinor,
          currency: record.currency,
          status: record.status,
          failureCode: record.failureCode,
          walletJournalId: record.walletJournalId,
          idempotencyKey: record.idempotencyKey,
          createdAt: toDate(record.createdAt),
          settledAt: record.settledAt === null ? null : toDate(record.settledAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'inserted' : 'duplicate';
  }

  async findBySource(
    market: MarketContext,
    kind: CreditKind,
    sourceId: string,
  ): Promise<CreditRecord | null> {
    const row = await this.prisma.tx(market).promotionsCreditIssuance.findFirst({
      where: { marketId: market.marketId, kind, sourceId },
    });
    return row === null ? null : toRecord(row);
  }

  async settle(
    market: MarketContext,
    id: Id<'PromotionCredit'>,
    result:
      | { readonly status: 'GRANTED'; readonly walletJournalId: string }
      | { readonly status: 'FAILED'; readonly failureCode: string },
    at: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).promotionsCreditIssuance.updateMany({
      where: { marketId: market.marketId, id, status: 'PENDING' },
      data: {
        status: result.status,
        settledAt: toDate(at),
        ...(result.status === 'GRANTED'
          ? { walletJournalId: result.walletJournalId }
          : { failureCode: result.failureCode }),
      },
    });
    return updated.count === 1;
  }

  async reservedTotal(market: MarketContext, promotionId: Id<'Promotion'>): Promise<bigint> {
    const sum = await this.prisma.tx(market).promotionsCreditIssuance.aggregate({
      where: { marketId: market.marketId, promotionId, status: { in: ['PENDING', 'GRANTED'] } },
      _sum: { amountMinor: true },
    });
    return sum._sum.amountMinor ?? 0n;
  }

  countLive(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    recipient?: Id<'Account'>,
  ): Promise<number> {
    return this.prisma.tx(market).promotionsCreditIssuance.count({
      where: {
        marketId: market.marketId,
        promotionId,
        status: { in: ['PENDING', 'GRANTED'] },
        ...(recipient === undefined ? {} : { recipientAccountId: recipient }),
      },
    });
  }

  async creditedForOrder(
    market: MarketContext,
    orderId: Id<'Order'>,
    kind: CreditKind,
  ): Promise<bigint> {
    const sum = await this.prisma.tx(market).promotionsCreditIssuance.aggregate({
      where: {
        marketId: market.marketId,
        orderId,
        kind,
        status: { in: ['PENDING', 'GRANTED', 'RECORDED'] },
      },
      _sum: { amountMinor: true },
    });
    return sum._sum.amountMinor ?? 0n;
  }

  async listForPromotion(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    limit: number,
  ): Promise<readonly CreditRecord[]> {
    const rows = await this.prisma.tx(market).promotionsCreditIssuance.findMany({
      where: { marketId: market.marketId, promotionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }
}
