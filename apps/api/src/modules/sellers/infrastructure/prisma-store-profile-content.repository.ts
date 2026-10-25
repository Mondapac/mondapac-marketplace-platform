import type { ContentHash, Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewStoreProfileRevision,
  PublishedRevisionRef,
  SealedStoreProfileContent,
  StoreProfileContentRepository,
} from '../application/ports/store-profile-content.repository';

/** A unique violation (Prisma P2002), however the driver adapter wraps it. */
const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'P2002';

/**
 * {@link StoreProfileContentRepository} on `sellers.store_profile_revisions` and the published
 * pointer of `sellers.store_profiles` (data design 3.8), through the Market-scoped client with
 * `marketId` at the top level of every `where`. The pointer is read in clear; the ciphertext is
 * read on its own so a caller that needs only the pointer never touches it.
 */
export class PrismaStoreProfileContentRepository implements StoreProfileContentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async published(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<PublishedRevisionRef | null> {
    const row = await this.prisma.tx(market).sellersStoreProfile.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: {
        publishedRevision: { select: { id: true, revisionNo: true, contentHash: true } },
      },
    });
    const revision = row?.publishedRevision;
    if (revision === null || revision === undefined) return null;
    return {
      revisionId: revision.id as Id<'StoreProfileRevision'>,
      revisionNo: revision.revisionNo,
      contentHash: revision.contentHash as ContentHash,
    };
  }

  async content(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'StoreProfileRevision'>,
  ): Promise<SealedStoreProfileContent | null> {
    const row = await this.prisma.tx(market).sellersStoreProfileRevision.findFirst({
      where: { marketId: market.marketId, sellerId, id: revisionId },
      select: { contentCiphertext: true },
    });
    return row === null ? null : (row.contentCiphertext as SealedStoreProfileContent);
  }

  async publish(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revision: NewStoreProfileRevision,
  ): Promise<'published' | 'stale' | 'no-profile'> {
    const tx = this.prisma.tx(market);
    const profile = await tx.sellersStoreProfile.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: { publishedRevisionId: true },
    });
    if (profile === null) return 'no-profile';
    try {
      await tx.sellersStoreProfileRevision.create({
        data: {
          id: revision.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId,
          revisionNo: revision.expectedRevisionNo + 1,
          contentCiphertext: revision.ciphertext,
          contentSchemaVersion: revision.schemaVersion,
          contentHash: revision.contentHash,
          authorAccountId: revision.authorAccountId,
          createdAt: new Date(revision.createdAt.epochMilliseconds),
        },
        select: { id: true },
      });
    } catch (error) {
      // Another save took this revision number first (the unique key of the seller's numbers).
      if (isUniqueViolation(error)) return 'stale';
      throw error;
    }
    // The pointer moves only from the revision the writer read; a save that came in between
    // already moved it, and this unit is rolled back by the caller.
    const moved = await tx.sellersStoreProfile.updateMany({
      where: {
        marketId: market.marketId,
        sellerId,
        publishedRevisionId: profile.publishedRevisionId,
      },
      data: { publishedRevisionId: revision.id },
    });
    return moved.count === 1 ? 'published' : 'stale';
  }
}
