import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ClaimTextImpactReader,
  ImpactTextPage,
  ImpactTextKind,
  ImpactTextRow,
} from '../application/ports/claim-text-impact.reader';
import { asTexts } from './locale-pick';

/**
 * The published texts of a Market, a bounded page at a time in id order (catalog design 6.5).
 * Products: every text row of the published revision; Offers: the description object of each
 * `published` Offer. Plain ORM reads on catalog tables, no raw SQL.
 */
export class PrismaClaimTextImpactReader implements ClaimTextImpactReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    query: { kind: ImpactTextKind; afterId: string | null; limit: number },
  ): Promise<ImpactTextPage> {
    const tx = this.prisma.tx(market);
    const after = query.afterId === null ? {} : { id: { gt: query.afterId } };
    let rows: ImpactTextRow[];
    let lastId: string | null;
    let count: number;
    if (query.kind === 'product') {
      const products = await tx.catalogProduct.findMany({
        where: { marketId: market.marketId, publishedRevisionId: { not: null }, ...after },
        orderBy: { id: 'asc' },
        take: query.limit,
        select: {
          id: true,
          publishedRevision: {
            select: {
              texts: {
                select: { locale: true, name: true, shortDescription: true, description: true },
              },
            },
          },
        },
      });
      count = products.length;
      lastId = products[products.length - 1]?.id ?? null;
      rows = products.map((product) => ({
        id: product.id,
        texts: (product.publishedRevision?.texts ?? []).flatMap((t) =>
          [t.name, t.shortDescription, t.description]
            .filter((text): text is string => typeof text === 'string' && text.length > 0)
            .map((text) => ({ locale: t.locale, text })),
        ),
      }));
    } else {
      const offers = await tx.catalogOffer.findMany({
        where: { marketId: market.marketId, status: 'published', ...after },
        orderBy: { id: 'asc' },
        take: query.limit,
        select: { id: true, description: true },
      });
      count = offers.length;
      lastId = offers[offers.length - 1]?.id ?? null;
      rows = offers.map((offer) => ({
        id: offer.id,
        texts: Object.entries(asTexts(offer.description) ?? {})
          .filter(([, text]) => typeof text === 'string' && text.length > 0)
          .map(([locale, text]) => ({ locale, text })),
      }));
    }
    return { rows, nextAfterId: count < query.limit ? null : lastId };
  }
}
