import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BatchCodeCount,
  BatchCodeRecord,
  BatchCodeRepository,
} from '../application/ports/batch-code.repository';

const CHUNK = 2000;

/** {@link BatchCodeRepository} on `promotions.promotion_batch_codes`, scoped by `marketId`. */
export class PrismaBatchCodeRepository implements BatchCodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, codeHash: string): Promise<BatchCodeRecord | null> {
    const row = await this.prisma.tx(market).promotionsBatchCode.findFirst({
      where: { marketId: market.marketId, codeHash },
    });
    return row === null
      ? null
      : {
          promotionId: row.promotionId as Id<'Promotion'>,
          usedAt:
            row.usedAt === null
              ? null
              : Temporal.Instant.fromEpochMilliseconds(row.usedAt.getTime()),
        };
  }

  async existing(market: MarketContext, hashes: readonly string[]): Promise<ReadonlySet<string>> {
    const found = new Set<string>();
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const rows = await this.prisma.tx(market).promotionsBatchCode.findMany({
        where: { marketId: market.marketId, codeHash: { in: hashes.slice(i, i + CHUNK) } },
        select: { codeHash: true },
      });
      for (const row of rows) found.add(row.codeHash);
    }
    return found;
  }

  async insertMany(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    batchId: Id<'PromotionBatch'>,
    hashes: readonly string[],
    at: Temporal.Instant,
  ): Promise<void> {
    const createdAt = new Date(at.epochMilliseconds);
    for (let i = 0; i < hashes.length; i += CHUNK) {
      await this.prisma.tx(market).promotionsBatchCode.createMany({
        data: hashes.slice(i, i + CHUNK).map((codeHash) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          codeHash,
          promotionId,
          batchId,
          createdAt,
        })),
      });
    }
  }

  async count(market: MarketContext, promotionId: Id<'Promotion'>): Promise<BatchCodeCount> {
    const tx = this.prisma.tx(market);
    const total = await tx.promotionsBatchCode.count({
      where: { marketId: market.marketId, promotionId },
    });
    const used = await tx.promotionsBatchCode.count({
      where: { marketId: market.marketId, promotionId, usedAt: { not: null } },
    });
    return { total, used };
  }
}
