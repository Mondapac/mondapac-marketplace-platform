import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { RedemptionRepository, UsageDelta } from '../application/ports/redemption.repository';
import { LockContendedError } from '../application/ports/promotion.repository';
import type {
  RedemptionKind,
  RedemptionRecord,
  RedemptionStatus,
  ReleaseReason,
} from '../domain/redemption';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly orderId: string;
  readonly promotionKey: string;
  readonly promotionId: string | null;
  readonly kind: string;
  readonly customerAccountId: string;
  readonly codeHash: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly sellerShareMinor: bigint;
  readonly platformShareMinor: bigint;
  readonly units: number | null;
  readonly budgetMonth: string | null;
  readonly status: string;
  readonly releaseReason: string | null;
  readonly reservedAt: Date;
  readonly confirmedAt: Date | null;
  readonly releasedAt: Date | null;
}

const toRecord = (row: Row): RedemptionRecord => ({
  id: row.id,
  orderId: row.orderId,
  promotionKey: row.promotionKey,
  promotionId: row.promotionId,
  kind: row.kind as RedemptionKind,
  customerAccountId: row.customerAccountId,
  codeHash: row.codeHash,
  currency: row.currency,
  amount: row.amountMinor,
  sellerShare: row.sellerShareMinor,
  platformShare: row.platformShareMinor,
  units: row.units,
  budgetMonth: row.budgetMonth,
  status: row.status as RedemptionStatus,
  releaseReason: row.releaseReason as ReleaseReason | null,
  reservedAt: fromDate(row.reservedAt),
  confirmedAt: row.confirmedAt === null ? null : fromDate(row.confirmedAt),
  releasedAt: row.releasedAt === null ? null : fromDate(row.releasedAt),
});

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** {@link RedemptionRepository} on `promotions.redemptions`, `promotion_usage` and the codes. */
export class PrismaRedemptionRepository implements RedemptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async forOrder(
    market: MarketContext,
    orderId: Id<'Order'>,
  ): Promise<readonly RedemptionRecord[]> {
    const rows = await this.prisma.tx(market).promotionsRedemption.findMany({
      where: { marketId: market.marketId, orderId },
      orderBy: { promotionKey: 'asc' },
    });
    return rows.map(toRecord);
  }

  async insertMany(market: MarketContext, records: readonly RedemptionRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.prisma.tx(market).promotionsRedemption.createMany({
      data: records.map((record) => ({
        id: record.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        orderId: record.orderId,
        promotionKey: record.promotionKey,
        promotionId: record.promotionId,
        kind: record.kind,
        customerAccountId: record.customerAccountId,
        codeHash: record.codeHash,
        currency: record.currency,
        amountMinor: record.amount,
        sellerShareMinor: record.sellerShare,
        platformShareMinor: record.platformShare,
        units: record.units,
        budgetMonth: record.budgetMonth,
        status: record.status,
        releaseReason: record.releaseReason,
        reservedAt: toDate(record.reservedAt),
        confirmedAt: record.confirmedAt === null ? null : toDate(record.confirmedAt),
        releasedAt: record.releasedAt === null ? null : toDate(record.releasedAt),
      })),
    });
  }

  async confirm(
    market: MarketContext,
    orderId: Id<'Order'>,
    at: Temporal.Instant,
  ): Promise<number> {
    const moved = await this.prisma.tx(market).promotionsRedemption.updateMany({
      where: { marketId: market.marketId, orderId, status: 'RESERVED' },
      data: { status: 'CONFIRMED', confirmedAt: toDate(at) },
    });
    return moved.count;
  }

  async release(
    market: MarketContext,
    orderId: Id<'Order'>,
    reason: ReleaseReason,
    at: Temporal.Instant,
    includeConfirmed: boolean,
  ): Promise<readonly RedemptionRecord[]> {
    const tx = this.prisma.tx(market);
    const statuses = includeConfirmed ? ['RESERVED', 'CONFIRMED'] : ['RESERVED'];
    const rows = await tx.promotionsRedemption.findMany({
      where: { marketId: market.marketId, orderId, status: { in: statuses } },
      orderBy: { promotionKey: 'asc' },
    });
    if (rows.length === 0) return [];
    // Each row moves only from the status it was read in: a row another unit moved meanwhile is
    // not counted, so its counters are never given back twice.
    const released: RedemptionRecord[] = [];
    for (const row of rows) {
      const moved = await tx.promotionsRedemption.updateMany({
        where: { marketId: market.marketId, id: row.id, status: row.status },
        data: { status: 'RELEASED', releaseReason: reason, releasedAt: toDate(at) },
      });
      if (moved.count === 1) released.push(toRecord(row));
    }
    return released;
  }

  async lockUsage(
    market: MarketContext,
    promotionIds: readonly Id<'Promotion'>[],
    at: Temporal.Instant,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const sorted = [...new Set(promotionIds)].sort(byId);
    if (sorted.length === 0) return;
    // ON CONFLICT DO NOTHING: the usual case (the row exists) changes nothing and aborts nothing.
    await tx.promotionsUsage.createMany({
      data: sorted.map((promotionId) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        promotionId,
        usesCount: 0,
        spentMinor: 0n,
        sellerShareMinor: 0n,
        platformShareMinor: 0n,
        updatedAt: toDate(at),
      })),
      skipDuplicates: true,
    });
    // The client sends no raw SQL: an update that adds zero takes the row lock and changes nothing.
    for (const promotionId of sorted) {
      const locked = await tx.promotionsUsage.updateMany({
        where: { marketId: market.marketId, promotionId },
        data: { usesCount: { increment: 0 } },
      });
      if (locked.count !== 1) throw new Error('promotions.usage row missing');
    }
  }

  async lockMarket(market: MarketContext): Promise<boolean> {
    const tx = this.prisma.tx(market);
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await tx.promotionsMarketSetting.findFirst({
        where: { marketId: market.marketId },
      });
      if (row === null) return false;
      const locked = await tx.promotionsMarketSetting.updateMany({
        where: { marketId: market.marketId, updatedAt: row.updatedAt },
        data: { updatedAt: row.updatedAt },
      });
      if (locked.count === 1) return true;
    }
    throw new LockContendedError('promotions.market');
  }

  async addUsage(
    market: MarketContext,
    deltas: readonly UsageDelta[],
    at: Temporal.Instant,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    for (const delta of [...deltas].sort((a, b) => byId(a.promotionId, b.promotionId))) {
      const moved = await tx.promotionsUsage.updateMany({
        where: { marketId: market.marketId, promotionId: delta.promotionId },
        data: {
          usesCount: { increment: delta.uses },
          spentMinor: { increment: delta.spent },
          sellerShareMinor: { increment: delta.sellerShare },
          platformShareMinor: { increment: delta.platformShare },
          updatedAt: toDate(at),
        },
      });
      if (moved.count !== 1) throw new Error('promotions.usage row missing');
    }
  }

  async customerUses(
    market: MarketContext,
    customerAccountId: Id<'Account'>,
    promotionIds: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, number>> {
    if (promotionIds.length === 0) return new Map();
    const groups = await this.prisma.tx(market).promotionsRedemption.groupBy({
      by: ['promotionId'],
      where: {
        marketId: market.marketId,
        customerAccountId,
        promotionId: { in: [...promotionIds] },
        status: { not: 'RELEASED' },
      },
      _count: { _all: true },
    });
    return new Map(
      groups.flatMap((group) =>
        group.promotionId === null
          ? []
          : [[group.promotionId as Id<'Promotion'>, group._count._all] as const],
      ),
    );
  }

  async unitsSold(
    market: MarketContext,
    promotionIds: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, number>> {
    if (promotionIds.length === 0) return new Map();
    const groups = await this.prisma.tx(market).promotionsRedemption.groupBy({
      by: ['promotionId'],
      where: {
        marketId: market.marketId,
        promotionId: { in: [...promotionIds] },
        status: { not: 'RELEASED' },
        units: { not: null },
      },
      _sum: { units: true },
    });
    const sold = new Map<Id<'Promotion'>, number>(promotionIds.map((id) => [id, 0]));
    for (const group of groups) {
      if (group.promotionId !== null) {
        sold.set(group.promotionId as Id<'Promotion'>, group._sum.units ?? 0);
      }
    }
    return sold;
  }

  async firstOrderSpent(market: MarketContext, budgetMonth: string): Promise<bigint> {
    const sum = await this.prisma.tx(market).promotionsRedemption.aggregate({
      where: {
        marketId: market.marketId,
        kind: 'FIRST_ORDER',
        budgetMonth,
        status: { not: 'RELEASED' },
      },
      _sum: { amountMinor: true },
    });
    return sum._sum.amountMinor ?? 0n;
  }

  async claimCode(
    market: MarketContext,
    codeHash: string,
    orderId: Id<'Order'>,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    // One statement decides: the row is claimed only while it is unused, so two orders racing for
    // one code cannot both win (the second waits on the row lock, then matches nothing).
    const claimed = await tx.promotionsBatchCode.updateMany({
      where: { marketId: market.marketId, codeHash, usedAt: null },
      data: { usedAt: toDate(at), redeemedOrderId: orderId },
    });
    if (claimed.count === 1) return true;
    const held = await tx.promotionsBatchCode.findFirst({
      where: { marketId: market.marketId, codeHash, redeemedOrderId: orderId },
      select: { codeHash: true },
    });
    return held !== null;
  }

  async unclaimCode(market: MarketContext, codeHash: string, orderId: Id<'Order'>): Promise<void> {
    await this.prisma.tx(market).promotionsBatchCode.updateMany({
      where: { marketId: market.marketId, codeHash, redeemedOrderId: orderId },
      data: { usedAt: null, redeemedOrderId: null },
    });
  }

  async staleReservations(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly Id<'Order'>[]> {
    const rows = await this.prisma.tx(market).promotionsRedemption.findMany({
      where: { marketId: market.marketId, status: 'RESERVED', reservedAt: { lt: toDate(before) } },
      orderBy: [{ reservedAt: 'asc' }, { id: 'asc' }],
      distinct: ['orderId'],
      select: { orderId: true },
      take: limit,
    });
    return rows.map((row) => row.orderId as Id<'Order'>);
  }
}
