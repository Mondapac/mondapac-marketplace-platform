import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CategoryTreeUnavailableError,
  liveCategoryTree,
  MAX_TREE_NODES,
  type LiveCategory,
} from '../../domain/category-tree';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';

export interface CategoryTreeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly treeReader: CategoryTreeReader;
  readonly policy: CatalogMarketPolicy;
}

export interface CategoryTreeAnswer {
  /** The Market default locale the names are in (INTL-13 fallback per category). */
  readonly locale: string;
  readonly categories: readonly LiveCategory[];
}

export type CategoryTreeFailure = { readonly code: 'catalog.categories-unavailable' };

/**
 * `catalog.category-tree`: the live platform category tree of the request's Market, for the buyer
 * site's left menu and Browse drawer (storefront reads package). Rule `anonymous`: category ids,
 * slugs and names are public content; no seller category, no count, nothing unpublished. One
 * read-only unit; a tree that cannot be built (see `liveCategoryTree`) or is larger than
 * {@link MAX_TREE_NODES} is `catalog.categories-unavailable`, never a partial tree.
 */
export class CategoryTreeQuery extends UseCase<
  Record<string, never>,
  CategoryTreeAnswer,
  CategoryTreeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-tree',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryTreeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<CategoryTreeAnswer, CategoryTreeFailure>> {
    const { market } = context;
    const locale = this.deps.policy.locales(market).default;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.treeReader.nodes(market, MAX_TREE_NODES + 1)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'catalog.categories-unavailable' });
    try {
      return ok({ locale, categories: liveCategoryTree(read.value, locale) });
    } catch (error) {
      if (error instanceof CategoryTreeUnavailableError) {
        return err({ code: 'catalog.categories-unavailable' });
      }
      throw error;
    }
  }
}
