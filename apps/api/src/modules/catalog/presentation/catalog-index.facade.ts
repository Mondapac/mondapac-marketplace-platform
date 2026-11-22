import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { OfferSearchFactsQuery } from '../application/use-cases/offer-search-facts.use-case';
import type { SearchIndexStampQuery } from '../application/use-cases/search-index-stamp.use-case';
import type { PublishedOfferIdsQuery } from '../application/use-cases/published-offer-ids.use-case';
import type { CategoryTreeQuery } from '../application/use-cases/category-tree.use-case';
import type { CategoryTreeSystemQuery } from '../application/use-cases/category-tree-system.use-case';
import type {
  CatalogBatchTooLarge,
  CatalogIndexFacade,
  IndexCategory,
  CatalogValidationFailed,
  OfferSearchFactsMap,
  PublishedOfferIdsInput,
} from '../contracts';

/** The `anonymous` / `system` pair behind {@link CatalogIndexFacade.categoryTree}. */
export interface CategoryTreePair {
  readonly tree: CategoryTreeQuery;
  readonly treeSystem: CategoryTreeSystemQuery;
}

/**
 * {@link CatalogIndexFacade}: each method passes the caller's context unchanged to one use case.
 * The one decision here is which of the category tree pair (the `anonymous` rule never admits the
 * system actor).
 */
export class CatalogIndexFacadeImplementation implements CatalogIndexFacade {
  constructor(
    private readonly facts: OfferSearchFactsQuery,
    private readonly published: PublishedOfferIdsQuery,
    private readonly stamp: SearchIndexStampQuery,
    private readonly categories: CategoryTreePair,
  ) {}

  offerSearchFacts(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<
    Result<OfferSearchFactsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  > {
    return this.facts.execute(context, { offerIds, locale });
  }

  publishedOfferIds(
    context: CallContext,
    input: PublishedOfferIdsInput,
  ): Promise<Result<readonly Id<'Offer'>[], AccessDenied | CatalogValidationFailed>> {
    return this.published.execute(context, input);
  }

  searchIndexStamp(context: CallContext): Promise<Result<string, AccessDenied>> {
    return this.stamp.execute(context, {});
  }

  async categoryTree(
    context: CallContext,
  ): Promise<
    Result<readonly IndexCategory[], { readonly code: 'catalog.categories-unavailable' }>
  > {
    const useCase =
      context.actor.kind === 'system' ? this.categories.treeSystem : this.categories.tree;
    const result = await useCase.execute(context, {});
    if (!result.ok)
      return { ok: false, error: { code: 'catalog.categories-unavailable' } } as const;
    return {
      ok: true,
      value: result.value.categories.map(({ id, parentId, slug, name, depth }) => ({
        id,
        parentId,
        slug,
        name,
        depth,
      })),
    } as const;
  }
}
