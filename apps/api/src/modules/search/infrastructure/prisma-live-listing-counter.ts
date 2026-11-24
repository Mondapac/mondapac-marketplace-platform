import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  LiveListingCounter,
  LiveListingCounts,
} from '../application/ports/live-listing-counter';

/**
 * {@link LiveListingCounter} on `search.offer_documents`: every document of the Market, and those
 * with no `offer_variant_documents` row in stock (Prisma's `none` is a correlated NOT EXISTS).
 * Measured on 200 k documents and 600 k variants (PR 6 query plans): the first count is an
 * index-only scan, the second a hash anti join over the Market's in-stock variants (about 20 ms
 * and 145 ms); the read grows with the Market's live Offers (a full count, no page). `tenant_id` is
 * not filtered here (one tenant; ADR-0001 seam, FE row).
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
