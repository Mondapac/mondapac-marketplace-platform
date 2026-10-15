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
import { MAX_PAGE, MAX_PAGE_SIZE } from '../domain/search-query';

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
    // The statements take whole numbers as text: assert the bounds here, whatever the caller did.
    const whole = (value: number, min: number, max: number): string => {
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new RangeError('search: page bounds out of range');
      }
      return String(value);
    };
    const limit = whole(request.limit, 1, MAX_PAGE_SIZE + 1);
    const offset = whole(request.offset, 0, MAX_PAGE * MAX_PAGE_SIZE);
    const { text, categoryId } = request;
    if (text === null) {
      if (categoryId === null) throw new RangeError('search: a browse needs a category');
      const rows = await this.rawReads.rawRead(market, 'search.offer-browse', {
        categoryIds: [categoryId],
        limit,
        offset,
      });
      return rows.map(hitOf);
    }
    if (categoryId === null) {
      const rows = await this.rawReads.rawRead(market, 'search.offer-search', {
        textSearchConfig: request.textSearchConfig,
        query: text,
        limit,
        offset,
      });
      return rows.map(hitOf);
    }
    const rows = await this.rawReads.rawRead(market, 'search.offer-search-in-category', {
      textSearchConfig: request.textSearchConfig,
      query: text,
      categoryIds: [categoryId],
      limit,
      offset,
    });
    return rows.map(hitOf);
  }
}
