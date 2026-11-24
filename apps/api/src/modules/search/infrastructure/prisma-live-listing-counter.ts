import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  LiveListingCounter,
  LiveListingCounts,
} from '../application/ports/live-listing-counter';

/**
 * {@link LiveListingCounter} on `search.offer_documents`: every document of the Market, and those
 * with no `offer_variant_documents` row in stock (a NOT EXISTS on the variant table's primary key
 * `(market_id, offer_id, variant_id)`). The documents are read on the `(market_id, product_id)`
 * index; the read grows with the Market's live Offers (a full count, no page).
 */
export class PrismaLiveListingCounter implements LiveListingCounter {
  constructor(private readonly prisma: PrismaService) {}

  async liveListings(market: MarketContext): Promise<LiveListingCounts> {
    const documents = this.prisma.tx(market).searchOfferDocument;
    const where = { marketId: market.marketId };
    const [active, outOfStock] = await Promise.all([
      documents.count({ where }),
      documents.count({ where: { ...where, variants: { none: { inStock: true } } } }),
    ]);
    return { active, outOfStock };
  }
}
