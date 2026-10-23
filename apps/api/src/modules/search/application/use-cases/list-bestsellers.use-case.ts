import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { MAX_PAGE_SIZE, type SearchValidationFailed } from '../../domain/search-query';
import { parseShelfQuery, type ShelfRequest } from '../../domain/shelf-query';
import type { OfferHit } from '../../domain/offer-document';
import type { ShelfDependencies } from '../shelf-dependencies';
import { withPrimaryImages } from '../product-images';
import type { ProductSearchItem, ProductSearchItemFacts } from './search-products.use-case';

/** How many ranked Offers are asked of ordering: enough to fill a shelf after drops. */
export const RANKED_DEPTH = 100;
/** How many documents in browse order are read to fill a short shelf. */
export const FILL_DEPTH = MAX_PAGE_SIZE + 1;

export interface ShelfPage {
  readonly items: readonly ProductSearchItem[];
}

export type ShelfFailure = SearchValidationFailed | { readonly code: 'search.unavailable' };

export const itemOf = ({
  offerId,
  productId,
  sellerId,
  name,
  shortText,
  categoryIds,
}: OfferHit): ProductSearchItemFacts => ({
  offerId,
  productId,
  sellerId,
  name,
  shortText,
  categoryIds,
});

/**
 * `search.list-bestsellers`: the storefront's best-sellers shelf. Rule `anonymous`: no session,
 * the request's Market. Ordering ranks the Offers by paid order lines over its window (ids only);
 * the ranked Offers that are indexed (and in the category, when one is asked) come first in rank
 * order; a short shelf is filled from search's browse order (the category's, or the Market's by
 * name). Every Offer is re-checked with catalog and sellers before it is shown; a source or check
 * that cannot be made is `search.unavailable`, never an unchecked list. Same item shape as the
 * search route: ids, text and categories, no badge, price or stock.
 */
export class ListBestsellers extends UseCase<ShelfRequest, ShelfPage, ShelfFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'search.list-bestsellers',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShelfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ShelfRequest,
  ): Promise<Result<ShelfPage, ShelfFailure>> {
    const query = parseShelfQuery(input);
    if (!query.ok) return query;
    const { categoryId, limit } = query.value;
    const { market } = context;

    const ranked = await this.deps.sources.bestSellingOfferIds(context, RANKED_DEPTH);
    if (ranked === null) return err({ code: 'search.unavailable' });
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const documents = await this.deps.shelves.byOfferIds(market, ranked);
        const fill =
          categoryId === null
            ? await this.deps.shelves.browseAll(market, FILL_DEPTH)
            : await this.deps.reader.search(market, {
                textSearchConfig: this.deps.policy.settings(market).textSearchConfig,
                text: null,
                categoryId,
                limit: FILL_DEPTH,
                offset: 0,
              });
        return ok({ documents, fill });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'search.unavailable' });

    const byId = new Map(read.value.documents.map((hit) => [hit.offerId, hit] as const));
    const inCategory = (hit: OfferHit) =>
      categoryId === null || hit.categoryIds.includes(categoryId);
    const first = ranked.flatMap((offerId) => {
      const hit = byId.get(offerId);
      return hit !== undefined && inCategory(hit) ? [hit] : [];
    });
    const taken = new Set(first.map((hit) => hit.offerId));
    const candidates = [...first, ...read.value.fill.filter((hit) => !taken.has(hit.offerId))];
    const visible = await this.deps.visibility.visible(context, candidates);
    if (visible === null) return err({ code: 'search.unavailable' });
    const items = await withPrimaryImages(
      this.deps.images,
      context,
      candidates
        .filter((hit) => visible.has(hit.offerId))
        .slice(0, limit)
        .map(itemOf),
    );
    return ok({ items });
  }
}
