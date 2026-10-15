import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  RawReadPort,
  RawReadRow,
} from '../../../platform/persistence/raw-reads/raw-read-port';
import type {
  OfferSearchReader,
  OfferSearchRequest,
} from '../application/ports/offer-search.reader';
import type { OfferHit } from '../domain/offer-document';

const hitOf = (row: RawReadRow<'search.offer-search'>): OfferHit => ({
  offerId: row.offerId as Id<'Offer'>,
  productId: row.productId as Id<'Product'>,
  sellerId: row.sellerId as Id<'Seller'>,
  name: row.name,
  shortText: row.shortText,
  categoryIds: row.categoryIds as Id<'Category'>[],
  rank: row.rank,
});

/**
 * {@link OfferSearchReader} over the module's own raw read port (ADR-0030): two listed
 * statements, both bound parameters only (the visitor's text is `$3`, never part of the SQL).
 * Runs inside the caller's read-only unit. Limit and offset are whole numbers made here from
 * checked integers and travel as text (the port's parameter types are uuid and text).
 */
export class RawOfferSearchReader implements OfferSearchReader {
  constructor(private readonly rawReads: RawReadPort) {}

  async search(market: MarketContext, request: OfferSearchRequest): Promise<readonly OfferHit[]> {
    const categoryIds = request.categoryId === null ? [] : [request.categoryId];
    const limit = String(request.limit);
    const offset = String(request.offset);
    if (request.text === null) {
      const rows = await this.rawReads.rawRead(market, 'search.offer-browse', {
        categoryIds,
        limit,
        offset,
      });
      return rows.map(hitOf);
    }
    const rows = await this.rawReads.rawRead(market, 'search.offer-search', {
      textSearchConfig: request.textSearchConfig,
      query: request.text,
      categoryIds,
      limit,
      offset,
    });
    return rows.map(hitOf);
  }
}
