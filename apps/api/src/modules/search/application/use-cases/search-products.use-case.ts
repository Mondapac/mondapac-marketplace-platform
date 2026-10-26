import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  parseSearchQuery,
  type SearchProductsRequest,
  type SearchValidationFailed,
} from '../../domain/search-query';
import type { ImageRef } from '../../domain/image-ref';
import { withPrimaryImages } from '../product-images';
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

export interface ProductSearchPage {
  readonly items: readonly ProductSearchItem[];
  readonly page: number;
  readonly pageSize: number;
  /** Whether the next result is visible; hidden matches never change it. */
  readonly hasMore: boolean;
}

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
    const { text, categoryId, storeSlug, page, pageSize } = query.value;
    const { textSearchConfig } = this.deps.policy.settings(market);
    const offset = (page - 1) * pageSize;

    let storeSellerId: Id<'Seller'> | null = null;
    if (storeSlug !== null) {
      const store = await this.deps.stores.sellerIdOf(context, storeSlug);
      if (store === null) return err({ code: 'search.unavailable' });
      if (store.sellerId === null) return ok({ items: [], page, pageSize, hasMore: false });
      storeSellerId = store.sellerId;
    }
    let categoryIds: readonly Id<'Category'>[] | null = null;
    if (categoryId !== null) {
      categoryIds = await this.deps.categories.subtreeOf(context, categoryId);
      if (categoryIds === null) return err({ code: 'search.unavailable' });
    }
    const hits = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          storeSellerId !== null
            ? await this.deps.shelves.browseBySeller(
                market,
                storeSellerId,
                categoryIds,
                pageSize + 1,
                offset,
              )
            : await this.deps.reader.search(market, {
                textSearchConfig,
                text,
                categoryIds,
                limit: pageSize + 1,
                offset,
              }),
        ),
      { readOnly: true },
    );
    if (!hits.ok) return err({ code: 'search.unavailable' });
    // The extra row is checked with the page, and `hasMore` says only whether it is visible: a
    // hidden match never shows through the flag (it may be false while later pages still hold
    // visible rows; the client then asks for the next page and finds them or an empty one).
    const visible = await this.deps.visibility.visible(context, hits.value);
    if (visible === null) return err({ code: 'search.unavailable' });
    const shown = hits.value.slice(0, pageSize);
    const extra = hits.value[pageSize];
    const hasMore = extra !== undefined && visible.has(extra.offerId);
    const facts = shown
      .filter((hit) => visible.has(hit.offerId))
      .map(
        ({
          offerId,
          productId,
          sellerId,
          name,
          shortText,
          categoryIds,
        }): ProductSearchItemFacts => ({
          offerId,
          productId,
          sellerId,
          name,
          shortText,
          categoryIds,
        }),
      );
    const items = await withPrimaryImages(this.deps.images, context, facts);
    return ok({ items, page, pageSize, hasMore });
  }
}
