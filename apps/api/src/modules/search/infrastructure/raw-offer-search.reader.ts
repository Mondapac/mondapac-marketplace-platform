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
import { MAX_FILTER_CATEGORIES } from '../domain/category-subtree';
import { priorMeanTimes1000 } from '../domain/rating-boost';
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
 * A category filter matches a document in any of the given categories (`&&`). Runs inside the
 * caller's read-only unit. With the Market's rating boost on (`request.ratingBoost`) a text search
 * uses the `-rated` statements, which multiply the rank by the product's stored factor, and
 * `sort: 'top-rated'` orders by the stored Bayesian average. Limit and offset are whole numbers made here from
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
    const { text, categoryIds } = request;
    if (
      categoryIds !== null &&
      (categoryIds.length < 1 || categoryIds.length > MAX_FILTER_CATEGORIES)
    ) {
      throw new RangeError('search: category filter size out of range');
    }
    // The rating boost (package 5): only while the Market's switch is on, and only for a text
    // search or the "Top rated" browse; a plain browse stays by name.
    const boost = request.ratingBoost;
    const top = request.sort === 'top-rated';
    if (top && boost === undefined)
      throw new RangeError('search: top-rated needs the rating boost');
    const prior = boost === undefined ? '' : String(priorMeanTimes1000(boost));
    if (text === null) {
      if (categoryIds === null) throw new RangeError('search: a browse needs a category');
      if (top) {
        const rows = await this.rawReads.rawRead(market, 'search.offer-browse-top-rated', {
          categoryIds,
          priorMeanTimes1000: prior,
          limit,
          offset,
        });
        return rows.map(hitOf);
      }
      const rows = await this.rawReads.rawRead(market, 'search.offer-browse', {
        categoryIds,
        limit,
        offset,
      });
      return rows.map(hitOf);
    }
    if (boost !== undefined) {
      const mode = top ? 'top' : 'boost';
      const rows =
        categoryIds === null
          ? await this.rawReads.rawRead(market, 'search.offer-search-rated', {
              textSearchConfig: request.textSearchConfig,
              query: text,
              mode,
              priorMeanTimes1000: prior,
              limit,
              offset,
            })
          : await this.rawReads.rawRead(market, 'search.offer-search-in-category-rated', {
              textSearchConfig: request.textSearchConfig,
              query: text,
              categoryIds,
              mode,
              priorMeanTimes1000: prior,
              limit,
              offset,
            });
      return rows.map(hitOf);
    }
    if (categoryIds === null) {
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
      categoryIds,
      limit,
      offset,
    });
    return rows.map(hitOf);
  }
}
