import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AllowedProductTypesSetting,
  ApprovedSellingFacts,
  SellingFactsRepository,
} from '../application/ports/selling-facts.repository';

const MAX_IDS = 100;

/** The revision statuses a revision can have once it was approved (a later one supersedes it). */
const ONCE_APPROVED = ['approved', 'superseded'];

/**
 * {@link SellingFactsRepository} on `sellers.seller_files`, `business_file_revisions`,
 * `admin_flags` and `seller_admin_settings`. The approved pointer is the authority (data design
 * 3.1); then the revisions it names and the open conflict flags. Three snapshots are safe: an
 * approved revision never changes (A18), and a flag raised between the reads is seen by the next
 * call (nothing is cached).
 */
export class PrismaSellingFactsRepository implements SellingFactsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async approvedSellingFacts(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, ApprovedSellingFacts>> {
    if (sellerIds.length === 0) return new Map();
    if (sellerIds.length > MAX_IDS) throw new RangeError('approvedSellingFacts: at most 100 ids');
    const tx = this.prisma.tx(market);
    const pointers = await tx.sellersSellerFile.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        approvedRevisionId: { not: null },
      },
      select: { sellerId: true, approvedRevisionId: true },
    });
    if (pointers.length === 0) return new Map();
    const withPointer = pointers.map((row) => row.sellerId);
    const revisions = await tx.sellersBusinessFileRevision.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: withPointer },
        id: { in: pointers.flatMap((row) => row.approvedRevisionId ?? []) },
        status: 'approved',
      },
      select: { id: true, sellerId: true, identifierIndex: true, operatingTimezone: true },
    });
    const flags = await tx.sellersAdminFlag.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: withPointer },
        code: 'identifier-claim-conflict',
        clearedAt: null,
      },
      select: { sellerId: true },
    });
    const conflicted = new Set(flags.map((row) => row.sellerId));
    const byRevision = new Map(revisions.map((row) => [row.id, row]));
    const facts = new Map<Id<'Seller'>, ApprovedSellingFacts>();
    for (const pointer of pointers) {
      const row = byRevision.get(pointer.approvedRevisionId ?? '');
      // A pointer to a revision that is not this seller's approved one is a fault of the data:
      // the entry stays absent, so the seller is not eligible (fail closed).
      if (row === undefined || row.sellerId !== pointer.sellerId) continue;
      facts.set(pointer.sellerId as Id<'Seller'>, {
        hasIdentifier: row.identifierIndex !== null,
        operatingTimezone: row.operatingTimezone,
        openClaimConflict: conflicted.has(pointer.sellerId),
      });
    }
    return facts;
  }

  async allowedProductTypes(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<AllowedProductTypesSetting | null> {
    const row = await this.prisma.tx(market).sellersSellerAdminSettings.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: { allProductTypesAllowed: true },
    });
    if (row === null) return null;
    return row.allProductTypesAllowed ? 'all' : 'listed';
  }

  async blogEnabled(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean | null> {
    const row = await this.prisma.tx(market).sellersSellerAdminSettings.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: { blogEnabled: true },
    });
    return row === null ? null : row.blogEnabled;
  }

  async firstApprovedAt(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<Temporal.Instant | null> {
    // A superseded revision was approved before a later one replaced it, so it still dates the
    // seller's start; a rejected or withdrawn one never does.
    const first = await this.prisma.tx(market).sellersBusinessFileRevision.aggregate({
      where: {
        marketId: market.marketId,
        sellerId,
        status: { in: ONCE_APPROVED },
        decidedAt: { not: null },
      },
      _min: { decidedAt: true },
    });
    const at = first._min.decidedAt;
    return at === null ? null : Temporal.Instant.fromEpochMilliseconds(at.getTime());
  }
}
