import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  parseSearchQuery,
  type SearchProductsRequest,
  type SearchValidationFailed,
} from '../../domain/search-query';
import type { ImageRef } from '../../domain/image-ref';
import { splitFacet } from '../../domain/search-filter';
import type { OfferHit } from '../../domain/offer-document';
import { gtinOfQuery, matchVariants } from '../../domain/variant-match';
import type { HitSellUnits } from '../ports/offer-variant.reader';
import { withProductImages } from '../product-images';
import {
  buildFilterViews,
  choiceGroups,
  countFacets,
  effectiveSelection,
  NO_SELECTION,
  numberBounds,
  type FacetFilterView,
} from '../search-facets';
import { MAX_FACET_ROWS, type FacetRow, type NumberRow } from '../ports/offer-facet.reader';
import type { FilterDefinition } from '../ports/search-filters';
import type { SearchDependencies } from '../search-dependencies';

/**
 * A result of the storefront search: ids, text, categories and the first photo (or null). No
 * badge, price or stock.
 */
export interface ProductSearchItem {
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly name: string;
  readonly shortText: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
  /** The first public photo of the product, or null (a draft or taken-down photo is never one). */
  readonly primaryImage: ImageRef | null;
}

/** A result before its photo is read. */
export type ProductSearchItemFacts = Omit<ProductSearchItem, 'primaryImage'>;

/**
 * A result of the search route: a {@link ProductSearchItem} with, from the index (variants V8),
 * the variant to open and the "From" price. No badge and no stock count.
 */
export interface SearchResultItem extends ProductSearchItem {
  /**
   * The variant the product page opens on (`?v=`): the matching one when a variant filter, the
   * price filter or an exact GTIN chose it; else null (the page shows its default variant).
   */
  readonly variantId: Id<'Variant'> | null;
  /**
   * The lowest buyer price of the matching in-stock variants (of all in-stock variants when nothing
   * narrowed to a variant) and whether they differ; null when none is in stock and priced. Read
   * from the index, refreshed on price and stock events; the cart re-reads the live price.
   */
  readonly price: { readonly from: Money; readonly varies: boolean } | null;
  /** Every public photo of the product (at most 8, main one first); `primaryImage` is the first. */
  readonly images: readonly ImageRef[];
}

/** A search result before its photo is read. */
type SearchResultFacts = Omit<SearchResultItem, 'primaryImage' | 'images'>;

export interface ProductSearchPage {
  readonly items: readonly SearchResultItem[];
  readonly page: number;
  readonly pageSize: number;
  /** Whether the next result is visible; hidden matches never change it. */
  readonly hasMore: boolean;
  /**
   * The filters of this listing with counts (attributes A7): the category's filter list, or the
   * global Brand and Country of origin on a text search. Empty for a store's or a brand's list.
   */
  readonly filters: readonly FacetFilterView[];
  /** Whether any filter narrowed the list: such a page is `noindex`, canonical to the category (ت۹). */
  readonly filtered: boolean;
  /** False when the scope was too large to count: option counts are then null. */
  readonly countsComplete: boolean;
  /**
   * The text was exactly one GTIN of a published variant, in stock or not (V8): the storefront goes straight to that
   * product page with `?v=`. Null otherwise.
   */
  readonly exactMatch: {
    readonly productId: Id<'Product'>;
    readonly variantId: Id<'Variant'>;
  } | null;
}

/** The facts of one visible hit, with what its sell units say (none read: no variant, no price). */
function factsOf(
  hit: OfferHit,
  units: HitSellUnits | undefined,
  match: (units: HitSellUnits) => Pick<SearchResultItem, 'variantId' | 'price'>,
): SearchResultFacts {
  const { offerId, productId, sellerId, name, shortText, categoryIds } = hit;
  const matched = units === undefined ? { variantId: null, price: null } : match(units);
  return {
    offerId,
    productId,
    sellerId,
    name,
    shortText,
    categoryIds,
    variantId: matched.variantId,
    price: matched.price,
  };
}

const NO_FACETS = {
  filters: [],
  filtered: false,
  countsComplete: true,
  exactMatch: null,
} as const;

export type SearchProductsFailure =
  SearchValidationFailed | { readonly code: 'search.unavailable' };

/**
 * `search.search-products`: the storefront query. Rule `anonymous`: no session is read, the
 * Market is the request's. One read-only unit asks the index for `pageSize + 1` documents of the
 * Market (text query ranked by `ts_rank`, ties by Offer id; or a browse by category, by name).
 * A category covers its subcategories: catalog's live tree names them first, and a tree that
 * cannot be read is `search.unavailable`;
 * then catalog and sellers are asked whether each hit is still sellable now. A hit that fails
 * either check is dropped, so a page can hold fewer than `pageSize` items while `hasMore` is
 * true. If a check cannot be made the answer is `search.unavailable`, never an unchecked list.
 * While the Market's rating boost is on (`search.ratingBoost`, off by default), the text rank is
 * multiplied by a stored rating factor of at most 10 % either way, and `sort=top-rated` orders by
 * the Bayesian average of the product stars instead; with the boost off `top-rated` is refused
 * (`validation.failed`, `sort`).
 * With a `brand` (no `q`, no `store`) the route lists the Offers of the brand's live products in the
 * Market by name (catalog names the product ids; an unknown, draft or archived brand answers an
 * empty page, a brand read that fails is `search.unavailable`).
 * With a `store` (no `q`) the route lists that store's Offers by name, optionally in one category:
 * sellers resolves the address under the published-store rules, and a store that is unknown,
 * retired or not selling answers an empty page, never an error or a hint of why. Text, categories,
 * ids and the first photo only: a certification badge comes from `evaluateClaim`, never from
 * indexed text.
 */
export class SearchProducts extends UseCase<
  SearchProductsRequest,
  ProductSearchPage,
  SearchProductsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.search-products',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SearchDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SearchProductsRequest,
  ): Promise<Result<ProductSearchPage, SearchProductsFailure>> {
    const query = parseSearchQuery(input);
    if (!query.ok) return query;
    const { market } = context;
    const { text, categoryId, direct, storeSlug, brandSlug, sort, page, pageSize, filters, price } =
      query.value;
    const asked = filters.choices.length + filters.ranges.length > 0;
    const { textSearchConfig, ratingBoost } = this.deps.policy.settings(market);
    // `top-rated` exists only while the Market's rating boost is on.
    if (sort === 'top-rated' && ratingBoost === null) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'sort', code: 'unavailable' }],
      });
    }
    const offset = (page - 1) * pageSize;
    // An exact GTIN goes straight to that variant (V8); an unknown one is searched as text.
    const gtin = text === null ? null : gtinOfQuery(text);
    if (gtin !== null) {
      const exact = await this.#byGtin(context, gtin, page, pageSize);
      if (exact === 'unavailable') return err({ code: 'search.unavailable' });
      if (exact !== null) return ok(exact);
    }

    let storeSellerId: Id<'Seller'> | null = null;
    if (storeSlug !== null) {
      const store = await this.deps.stores.sellerIdOf(context, storeSlug);
      if (store === null) return err({ code: 'search.unavailable' });
      if (store.sellerId === null)
        return ok({ items: [], page, pageSize, hasMore: false, ...NO_FACETS });
      storeSellerId = store.sellerId;
    }
    let brandProductIds: readonly Id<'Product'>[] | null = null;
    if (brandSlug !== null) {
      const brand = await this.deps.brands.productIdsOf(context, brandSlug);
      if (brand === null) return err({ code: 'search.unavailable' });
      if (brand.productIds.length === 0)
        return ok({ items: [], page, pageSize, hasMore: false, ...NO_FACETS });
      brandProductIds = brand.productIds;
    }
    let categoryIds: readonly Id<'Category'>[] | null = null;
    if (categoryId !== null && direct) {
      // "Other {name}" (C6): the products on the category itself, none of a subcategory's.
      categoryIds = [categoryId];
    } else if (categoryId !== null) {
      categoryIds = await this.deps.categories.subtreeOf(context, categoryId);
      if (categoryIds === null) return err({ code: 'search.unavailable' });
    }
    // Attribute filters (A7): only a text search or a category list has them. Catalog says which
    // attributes are the listing's filters; a request that names filters it cannot check fails closed.
    const filterable = storeSellerId === null && brandProductIds === null;
    let definitions: readonly FilterDefinition[] = [];
    if (filterable) {
      const offered = await this.deps.filterSource.filters(context, {
        categoryId,
        locale: this.deps.policy.settings(market).locale,
        brandSlugs: [],
        countryCodes: [],
      });
      if (offered === null) {
        if (asked) return err({ code: 'search.unavailable' });
      } else {
        definitions = offered;
      }
    }
    const selection = filterable
      ? effectiveSelection(filters, new Map(definitions.map((d) => [d.code, d])))
      : NO_SELECTION;
    // The price filter (V8) needs no filter list: it reads the sell units of any text or category list.
    const priceRange = storeSellerId === null && brandProductIds === null ? price : null;
    const narrowed = selection.choices.length + selection.ranges.length > 0 || priceRange !== null;
    const groups = choiceGroups(selection);
    const scope = {
      textSearchConfig,
      text,
      categoryIds,
      ranges: selection.ranges,
      price: priceRange,
    };
    const rangeCodes = definitions.filter((d) => d.kind === 'range').map((d) => d.code);
    const counted = definitions.length > 0 && (text !== null || categoryIds !== null);
    const hits = await this.deps.unitOfWork.run(
      market,
      async () => {
        const list =
          brandProductIds !== null
            ? await this.deps.shelves.browseByProducts(
                market,
                brandProductIds,
                categoryIds,
                pageSize + 1,
                offset,
              )
            : storeSellerId !== null
              ? await this.deps.shelves.browseBySeller(
                  market,
                  storeSellerId,
                  categoryIds,
                  pageSize + 1,
                  offset,
                )
              : narrowed
                ? await this.deps.facets.searchFiltered(market, {
                    textSearchConfig,
                    text,
                    categoryIds,
                    limit: pageSize + 1,
                    offset,
                    choiceGroups: groups,
                    ranges: selection.ranges,
                    price: priceRange,
                    ...(ratingBoost === null ? {} : { ratingBoost }),
                    ...(sort === 'top-rated' ? { sort } : {}),
                  })
                : await this.deps.reader.search(market, {
                    textSearchConfig,
                    text,
                    categoryIds,
                    limit: pageSize + 1,
                    offset,
                    ...(ratingBoost === null ? {} : { ratingBoost }),
                    ...(sort === 'top-rated' ? { sort } : {}),
                  });
        const rows: readonly FacetRow[] = counted
          ? await this.deps.facets.facetRows(market, scope)
          : [];
        // The bounds of a range are those of the whole scope, so the slider does not jump.
        const numbers: readonly NumberRow[] =
          counted && rangeCodes.length > 0
            ? await this.deps.facets.numberRows(market, { ...scope, ranges: [] }, rangeCodes)
            : [];
        const units = await this.deps.variants.sellUnitsOf(
          market,
          list.map((hit) => hit.offerId),
        );
        return ok({ list, rows, numbers, units });
      },
      { readOnly: true },
    );
    if (!hits.ok) return err({ code: 'search.unavailable' });
    // The extra row is checked with the page, and `hasMore` says only whether it is visible: a
    // hidden match never shows through the flag (it may be false while later pages still hold
    // visible rows; the client then asks for the next page and finds them or an empty one).
    const visible = await this.deps.visibility.visible(context, hits.value.list);
    if (visible === null) return err({ code: 'search.unavailable' });
    const shown = hits.value.list.slice(0, pageSize);
    const extra = hits.value.list[pageSize];
    const hasMore = extra !== undefined && visible.has(extra.offerId);
    const facts = shown
      .filter((hit) => visible.has(hit.offerId))
      .map((hit) =>
        factsOf(hit, hits.value.units.get(hit.offerId), (units) =>
          matchVariants({ ...units, groups, price: priceRange }),
        ),
      );
    const items = await withProductImages(this.deps.images, context, facts);
    const views = counted
      ? await this.filterViews(context, definitions, selection, hits.value.rows, hits.value.numbers)
      : null;
    return ok({
      items,
      page,
      pageSize,
      hasMore,
      filters: views?.filters ?? [],
      filtered: narrowed,
      countsComplete: views?.complete ?? true,
      exactMatch: null,
    });
  }

  /**
   * The results of an exact GTIN (V8): the documents whose sell unit has it, each opening on that
   * variant, if any is visible now; null when no indexed unit has it (the text is then searched as
   * usual). Only page 1 has items. `unavailable` when a read or the visibility check failed.
   */
  async #byGtin(
    context: CallContext,
    gtin: string,
    page: number,
    pageSize: number,
  ): Promise<ProductSearchPage | null | 'unavailable'> {
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const found = await this.deps.variants.unitsWithGtin(market, gtin);
        const offerIds = [...new Set(found.map((unit) => unit.offerId))];
        const [list, units] = await Promise.all([
          this.deps.variants.hitsOf(market, offerIds),
          this.deps.variants.sellUnitsOf(market, offerIds),
        ]);
        return ok({ found, list, units });
      },
      { readOnly: true },
    );
    if (!read.ok) return 'unavailable';
    const { found, list, units } = read.value;
    if (list.length === 0) return null;
    const visible = await this.deps.visibility.visible(context, list);
    if (visible === null) return 'unavailable';
    const shown = list.filter((hit) => visible.has(hit.offerId));
    if (shown.length === 0) return null;
    const variantOf = new Map(found.map((unit) => [unit.offerId, unit.variantId]));
    const facts = (page === 1 ? shown.slice(0, pageSize) : []).map((hit) =>
      factsOf(hit, units.get(hit.offerId), (sellUnits) => {
        const variantId = variantOf.get(hit.offerId) ?? null;
        const unit = sellUnits.variants.find((v) => v.variantId === variantId);
        return {
          variantId,
          price:
            unit !== undefined && unit.inStock && unit.price !== null
              ? { from: unit.price, varies: false }
              : null,
        };
      }),
    );
    const items = await withProductImages(this.deps.images, context, facts);
    const first = shown[0]!;
    return {
      items,
      page,
      pageSize,
      hasMore: page === 1 && shown.length > pageSize,
      filters: [],
      filtered: false,
      countsComplete: true,
      // A later page has no items, so it names no match to open.
      exactMatch:
        page === 1
          ? { productId: first.productId, variantId: variantOf.get(first.offerId)! }
          : null,
    };
  }

  /**
   * The filter views with counts. Counting is done here over the scope's documents (one read, at
   * most {@link MAX_FACET_ROWS}; a larger scope is not counted and says so). The global Brand and
   * Country filters name their options from what was counted: catalog gives the brand names.
   */
  private async filterViews(
    context: CallContext,
    offered: readonly FilterDefinition[],
    selection: ReturnType<typeof effectiveSelection>,
    allRows: readonly FacetRow[],
    numbers: readonly NumberRow[],
  ): Promise<{ filters: FacetFilterView[]; complete: boolean }> {
    // A read cut at the cap (facets or numbers) cannot give true counts or true slider bounds.
    // The facet read is capped in documents, each of which may come once per sell unit (V8).
    const documents = new Set<string>();
    const rows = allRows.filter((row) => {
      if (documents.has(row.offerId)) return true;
      if (documents.size >= MAX_FACET_ROWS) return false;
      documents.add(row.offerId);
      return true;
    });
    const complete = rows.length === allRows.length && numbers.length <= MAX_FACET_ROWS;
    const counts = countFacets(
      rows,
      selection.choices,
      offered.filter((d) => d.kind !== 'range').map((d) => d.code),
    );
    let definitions = offered;
    if (offered.some((d) => d.code === 'brand')) {
      // The global filters: options are the brands and countries found (and any picked).
      const found = (attr: string): string[] => {
        const values = new Set<string>(
          selection.choices.find((c) => c.attr === attr)?.values ?? [],
        );
        for (const [facet, count] of counts) {
          const split = splitFacet(facet);
          if (split !== null && split.attr === attr && count > 0) values.add(split.value);
        }
        return [...values];
      };
      const named = await this.deps.filterSource.filters(context, {
        categoryId: null,
        locale: this.deps.policy.settings(context.market).locale,
        brandSlugs: found('brand'),
        countryCodes: found('country-of-origin'),
      });
      if (named === null) return { filters: [], complete };
      definitions = named;
    }
    return {
      filters: buildFilterViews({
        definitions,
        selection,
        counts,
        counted: complete,
        bounds: complete ? numberBounds(numbers) : new Map(),
      }),
      complete,
    };
  }
}
