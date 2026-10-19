import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PendingProductRevisionsReader } from '../application/ports/pending-product-revisions.reader';

/**
 * {@link PendingProductRevisionsReader}: the products of the Market whose `pending_revision_id`
 * is one of the requested ids. One statement, scoped by `market_id`.
 */
export class PrismaPendingProductRevisionsReader implements PendingProductRevisionsReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    revisionIds: readonly Id<'ProductRevision'>[],
  ): Promise<ReadonlySet<Id<'ProductRevision'>>> {
    if (revisionIds.length === 0) return new Set();
    const rows = await this.prisma.tx(market).catalogProduct.findMany({
      where: { marketId: market.marketId, pendingRevisionId: { in: [...revisionIds] } },
      select: { pendingRevisionId: true },
    });
    return new Set(
      rows
        .map((row) => row.pendingRevisionId)
        .filter((id): id is string => id !== null) as Id<'ProductRevision'>[],
    );
  }
}
