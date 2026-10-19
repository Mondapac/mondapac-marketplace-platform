import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  PendingProductRevisionsReader,
  ProductRevisionRef,
} from '../application/ports/pending-product-revisions.reader';

/**
 * {@link PendingProductRevisionsReader}: the requested products of the Market by `(market_id, id)`
 * (the unique key, so no scan), then their `pending_revision_id` compared with the requested
 * revision. One statement, scoped by `market_id`.
 */
export class PrismaPendingProductRevisionsReader implements PendingProductRevisionsReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    revisions: readonly ProductRevisionRef[],
  ): Promise<ReadonlySet<Id<'ProductRevision'>>> {
    if (revisions.length === 0) return new Set();
    const rows = await this.prisma.tx(market).catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(revisions.map((ref) => ref.productId))] },
      },
      select: { id: true, pendingRevisionId: true },
    });
    const pendingOf = new Map(rows.map((row) => [row.id, row.pendingRevisionId] as const));
    return new Set(
      revisions
        .filter((ref) => pendingOf.get(ref.productId) === ref.revisionId)
        .map((ref) => ref.revisionId),
    );
  }
}
