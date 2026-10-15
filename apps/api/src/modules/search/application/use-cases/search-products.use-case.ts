import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  parseSearchQuery,
  type SearchProductsRequest,
  type SearchValidationFailed,
} from '../../domain/search-query';
import type { SearchDependencies } from '../search-dependencies';

/** A result of the storefront search: ids, text and categories. No badge, price or stock. */
export interface ProductSearchItem {
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly name: string;
  readonly shortText: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
}

export interface ProductSearchPage {
  readonly items: readonly ProductSearchItem[];
  readonly page: number;
  readonly pageSize: number;
  /** Whether the index holds more matches after this page (before the visibility re-check). */
  readonly hasMore: boolean;
}

export type SearchProductsFailure =
  SearchValidationFailed | { readonly code: 'search.unavailable' };

/**
 * `search.search-products`: the storefront query. Rule `anonymous`: no session is read, the
 * Market is the request's. One read-only unit asks the index for `pageSize + 1` documents of the
 * Market (text query ranked by `ts_rank`, ties by Offer id; or a browse by category, by name);
 * then catalog and sellers are asked whether each hit is still sellable now. A hit that fails
 * either check is dropped, so a page can hold fewer than `pageSize` items while `hasMore` is
 * true. If a check cannot be made the answer is `search.unavailable`, never an unchecked list.
 * Text, categories and ids only: a certification badge comes from `evaluateClaim`, never from
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
    const { text, categoryId, page, pageSize } = query.value;
    const { textSearchConfig } = this.deps.policy.settings(market);

    const hits = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.reader.search(market, {
            textSearchConfig,
            text,
            categoryId,
            limit: pageSize + 1,
            offset: (page - 1) * pageSize,
          }),
        ),
      { readOnly: true },
    );
    if (!hits.ok) return err({ code: 'search.unavailable' });
    const hasMore = hits.value.length > pageSize;
    const shown = hits.value.slice(0, pageSize);

    const visible = await this.deps.visibility.visible(context, shown);
    if (visible === null) return err({ code: 'search.unavailable' });
    const items = shown
      .filter((hit) => visible.has(hit.offerId))
      .map(({ offerId, productId, sellerId, name, shortText, categoryIds }) => ({
        offerId,
        productId,
        sellerId,
        name,
        shortText,
        categoryIds,
      }));
    return ok({ items, page, pageSize, hasMore });
  }
}
