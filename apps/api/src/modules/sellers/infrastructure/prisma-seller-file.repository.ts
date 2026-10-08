import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerFileRepository } from '../application/ports/seller-file.repository';
import { NEW_SELLER_ADMIN_SETTINGS, type SellerFile } from '../domain/seller-file';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** The largest id list one read takes (sellers design 7.1: `sellerSummaries` is bounded by its caller). */
const MAX_IDS = 100;

/**
 * {@link SellerFileRepository} on `sellers.seller_files` and the three roots that share its id
 * (data design 3.1, 3.7, 3.8, 3.9). Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`; writes are single statements, never nested. The file
 * is inserted first with `skipDuplicates`: a count of zero means a file of this id exists, and
 * nothing else is written, so a repeated or concurrent creation converges on the primary key.
 */
export class PrismaSellerFileRepository implements SellerFileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async addWithRoots(market: MarketContext, file: SellerFile): Promise<boolean> {
    const state = file.state;
    const tx = this.prisma.tx(market);
    const { count } = await tx.sellersSellerFile.createMany({
      data: [
        {
          sellerId: state.sellerId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          origin: state.origin,
          approvalRequiredAtRegistration: state.approvalRequiredAtRegistration,
          draftComplete: state.draftComplete,
          lastChangedAt: toDate(state.lastChangedAt),
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return false;

    const common = {
      sellerId: state.sellerId,
      marketId: market.marketId,
      tenantId: market.tenantId,
      version: 1,
      createdAt: toDate(state.createdAt),
    };
    await tx.sellersSellerAdminSettings.create({
      data: { ...common, ...NEW_SELLER_ADMIN_SETTINGS },
      select: { sellerId: true },
    });
    await tx.sellersSellerTaxProfile.create({ data: common, select: { sellerId: true } });
    await tx.sellersStoreProfile.create({ data: common, select: { sellerId: true } });
    return true;
  }

  async existingIds(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlySet<Id<'Seller'>>> {
    if (sellerIds.length === 0) return new Set();
    if (sellerIds.length > MAX_IDS) throw new RangeError('existingIds: at most 100 ids');
    const rows = await this.prisma.tx(market).sellersSellerFile.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
      select: { sellerId: true },
    });
    return new Set(rows.map((row) => row.sellerId as Id<'Seller'>));
  }
}
