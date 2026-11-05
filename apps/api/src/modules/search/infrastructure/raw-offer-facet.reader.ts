import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  RawReadPort,
  RawReadParams,
} from '../../../platform/persistence/raw-reads/raw-read-port';
import {
  MAX_FACET_ROWS,
  type FacetRow,
  type FacetScope,
  type FilteredSearchRequest,
  type NumberRow,
  type OfferFacetReader,
} from '../application/ports/offer-facet.reader';
import type { OfferHit } from '../domain/offer-document';
import { MAX_FILTER_CATEGORIES } from '../domain/category-subtree';
import { MAX_CHOICE_FILTERS, MAX_RANGE_FILTERS, type RangeFilter } from '../domain/search-filter';
import { priorMeanTimes1000 } from '../domain/rating-boost';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../domain/search-query';

/** Lower and upper bound of a number the index can hold (15 digits and a fraction). */
const LOW = '-999999999999999';
const HIGH = '999999999999999';
const NO_RANGE = { attr: '', min: LOW, max: HIGH } as const;

const whole = (value: number, min: number, max: number): string => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError('search: bounds out of range');
  }
  return String(value);
};

function categoriesOf(categoryIds: readonly Id<'Category'>[] | null): readonly string[] {
  if (categoryIds === null) return [];
  if (categoryIds.length < 1 || categoryIds.length > MAX_FILTER_CATEGORIES) {
    throw new RangeError('search: category filter size out of range');
  }
  return categoryIds;
}

/** The three range slots; an empty attribute is no range. */
function rangeSlots(ranges: readonly RangeFilter[]) {
  if (ranges.length > MAX_RANGE_FILTERS) throw new RangeError('search: too many ranges');
  const slot = (index: number) => {
    const range = ranges[index];
    return range === undefined
      ? NO_RANGE
      : { attr: range.attr, min: range.min ?? LOW, max: range.max ?? HIGH };
  };
  const [one, two, three] = [slot(0), slot(1), slot(2)];
  return {
    range1Attr: one.attr,
    range1Min: one.min,
    range1Max: one.max,
    range2Attr: two.attr,
    range2Min: two.min,
    range2Max: two.max,
    range3Attr: three.attr,
    range3Min: three.min,
    range3Max: three.max,
  };
}

/**
 * {@link OfferFacetReader} over the module's raw read port: three listed statements, bound
 * parameters only (the visitor's text is `$3`, the filter values are arrays and strings). Every
 * checked value is whole text or an array of text; a bound that is not a number never reaches the
 * statement (the use case checks the shape, the reader asserts the sizes).
 */
export class RawOfferFacetReader implements OfferFacetReader {
  constructor(private readonly rawReads: RawReadPort) {}

  async searchFiltered(
    market: MarketContext,
    request: FilteredSearchRequest,
  ): Promise<readonly OfferHit[]> {
    const limit = whole(request.limit, 1, MAX_PAGE_SIZE + 1);
    const offset = whole(request.offset, 0, MAX_PAGE * MAX_PAGE_SIZE);
    const categoryIds = categoriesOf(request.categoryIds);
    const text = request.text ?? '';
    if (text === '' && categoryIds.length === 0) {
      throw new RangeError('search: a filtered browse needs a category');
    }
    if (request.choiceGroups.length > MAX_CHOICE_FILTERS) {
      throw new RangeError('search: too many choice filters');
    }
    const boost = request.ratingBoost;
    const top = request.sort === 'top-rated';
    if (top && boost === undefined)
      throw new RangeError('search: top-rated needs the rating boost');
    const group = (index: number): readonly string[] => request.choiceGroups[index] ?? [];
    const params: RawReadParams<'search.offer-filtered'> = {
      textSearchConfig: request.textSearchConfig,
      query: text,
      categoryIds,
      choice1: group(0),
      choice2: group(1),
      choice3: group(2),
      choice4: group(3),
      choice5: group(4),
      choice6: group(5),
      choice7: group(6),
      choice8: group(7),
      ...rangeSlots(request.ranges),
      mode: boost === undefined ? 'none' : top ? 'top' : 'boost',
      priorMeanTimes1000: boost === undefined ? '0' : String(priorMeanTimes1000(boost)),
      limit,
      offset,
    };
    const rows = await this.rawReads.rawRead(market, 'search.offer-filtered', params);
    return rows.map((row) => ({
      offerId: row.offerId as Id<'Offer'>,
      productId: row.productId as Id<'Product'>,
      sellerId: row.sellerId as Id<'Seller'>,
      name: row.name,
      shortText: row.shortText,
      categoryIds: row.categoryIds as Id<'Category'>[],
      rank: row.rank,
    }));
  }

  async facetRows(market: MarketContext, scope: FacetScope): Promise<readonly FacetRow[]> {
    const categoryIds = categoriesOf(scope.categoryIds);
    const text = scope.text ?? '';
    if (text === '' && categoryIds.length === 0) {
      throw new RangeError('search: a facet read needs a text or a category');
    }
    const rows = await this.rawReads.rawRead(market, 'search.offer-facet-rows', {
      textSearchConfig: scope.textSearchConfig,
      query: text,
      categoryIds,
      ...rangeSlots(scope.ranges),
      limit: whole(MAX_FACET_ROWS + 1, 1, MAX_FACET_ROWS + 1),
    });
    return rows.map((row) => ({ productId: row.productId as Id<'Product'>, facets: row.facets }));
  }

  async numberRows(
    market: MarketContext,
    scope: FacetScope,
    attrs: readonly string[],
  ): Promise<readonly NumberRow[]> {
    if (attrs.length === 0) return [];
    if (attrs.length > 20) throw new RangeError('search: too many attributes');
    const categoryIds = categoriesOf(scope.categoryIds);
    const text = scope.text ?? '';
    if (text === '' && categoryIds.length === 0) {
      throw new RangeError('search: a number read needs a text or a category');
    }
    const rows = await this.rawReads.rawRead(market, 'search.offer-number-rows', {
      textSearchConfig: scope.textSearchConfig,
      query: text,
      categoryIds,
      attrs,
      limit: whole(MAX_FACET_ROWS + 1, 1, MAX_FACET_ROWS + 1),
    });
    return rows.map((row) => ({ attr: row.attr, value: row.value }));
  }
}
