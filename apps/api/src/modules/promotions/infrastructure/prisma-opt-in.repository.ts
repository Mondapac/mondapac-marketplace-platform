import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OptInRecord, OptInRepository } from '../application/ports/opt-in.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** {@link OptInRepository} on `promotions.co_funding_opt_ins`, scoped by `marketId`. */
export class PrismaOptInRepository implements OptInRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    sellerId: Id<'Seller'>,
  ): Promise<OptInRecord | null> {
    const row = await this.prisma.tx(market).promotionsCoFundingOptIn.findFirst({
      where: { marketId: market.marketId, promotionId, sellerId },
    });
    return row === null
      ? null
      : {
          promotionId,
          sellerId,
          optedInAt: fromDate(row.optedInAt),
          withdrawnAt: row.withdrawnAt === null ? null : fromDate(row.withdrawnAt),
        };
  }

  async optIn(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.promotionsCoFundingOptIn.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          promotionId,
          sellerId,
          optedInAt: toDate(at),
          withdrawnAt: null,
          decidedByAccountId: by,
        },
      ],
      skipDuplicates: true,
    });
    // An earlier row (a withdrawal) is set live again.
    await tx.promotionsCoFundingOptIn.updateMany({
      where: { marketId: market.marketId, promotionId, sellerId, withdrawnAt: { not: null } },
      data: { optedInAt: toDate(at), withdrawnAt: null, decidedByAccountId: by },
    });
  }

  async withdraw(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void> {
    await this.prisma.tx(market).promotionsCoFundingOptIn.updateMany({
      where: { marketId: market.marketId, promotionId, sellerId, withdrawnAt: null },
      data: { withdrawnAt: toDate(at), decidedByAccountId: by },
    });
  }

  async withdrawAll(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<readonly Id<'Seller'>[]> {
    const tx = this.prisma.tx(market);
    const live = await tx.promotionsCoFundingOptIn.findMany({
      where: { marketId: market.marketId, promotionId, withdrawnAt: null },
      orderBy: { sellerId: 'asc' },
    });
    if (live.length === 0) return [];
    await tx.promotionsCoFundingOptIn.updateMany({
      where: { marketId: market.marketId, promotionId, withdrawnAt: null },
      data: { withdrawnAt: toDate(at), decidedByAccountId: by },
    });
    return live.map((row) => row.sellerId as Id<'Seller'>);
  }

  async liveSellers(
    market: MarketContext,
    promotionIds: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, readonly Id<'Seller'>[]>> {
    if (promotionIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).promotionsCoFundingOptIn.findMany({
      where: {
        marketId: market.marketId,
        promotionId: { in: [...promotionIds] },
        withdrawnAt: null,
      },
      orderBy: { sellerId: 'asc' },
    });
    const out = new Map<Id<'Promotion'>, Id<'Seller'>[]>();
    for (const row of rows) {
      const id = row.promotionId as Id<'Promotion'>;
      out.set(id, [...(out.get(id) ?? []), row.sellerId as Id<'Seller'>]);
    }
    return out;
  }
}
