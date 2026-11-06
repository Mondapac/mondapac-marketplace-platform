import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CategoryTreeUnavailableError,
  liveCategoryTree,
  MAX_TREE_NODES,
} from '../../domain/category-tree';
import { publicCategoryTree, type PublicCategory } from '../../domain/public-category';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { PublicCategoryReader } from '../ports/public-category.reader';

export interface PublicCategoryTreeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly treeReader: CategoryTreeReader;
  readonly publicCategories: PublicCategoryReader;
  readonly policy: CatalogMarketPolicy;
}

export interface PublicCategoryTreeInput {
  /** The buyer's language; one the Market does not support falls back to its default. */
  readonly locale?: string;
}

export interface PublicCategoryTreeAnswer {
  /** The locale the names and short descriptions were asked in (after the fallback). */
  readonly locale: string;
  /** The Market's default locale: a text missing in `locale` is in this one. */
  readonly defaultLocale: string;
  readonly categories: readonly PublicCategory[];
}

export type PublicCategoryTreeFailure = { readonly code: 'catalog.categories-unavailable' };

/**
 * `catalog.public-category-tree` (categories C6a): the live platform category tree for the buyer
 * site, depth first in the admin's order, with per-locale name and short description, the menu
 * flags (a category out of the menu is flagged, not dropped, so its page still resolves), the
 * English SEO fields and "has live products" (plan decision 11). Rule `anonymous`: published
 * content only, no count, no seller category. One read-only unit; a tree that cannot be built is
 * `catalog.categories-unavailable`, never a partial tree.
 */
export class PublicCategoryTreeQuery extends UseCase<
  PublicCategoryTreeInput,
  PublicCategoryTreeAnswer,
  PublicCategoryTreeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.public-category-tree',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublicCategoryTreeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PublicCategoryTreeInput,
  ): Promise<Result<PublicCategoryTreeAnswer, PublicCategoryTreeFailure>> {
    const { market } = context;
    const locales = this.deps.policy.locales(market);
    const locale =
      input.locale !== undefined && locales.supported.includes(input.locale)
        ? input.locale
        : locales.default;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const nodes = await this.deps.treeReader.nodes(market, MAX_TREE_NODES + 1);
        const details = await this.deps.publicCategories.details(market, MAX_TREE_NODES + 1);
        const liveCounts = await this.deps.publicCategories.liveProductCounts(
          market,
          MAX_TREE_NODES + 1,
        );
        return ok({ nodes, details, liveCounts });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'catalog.categories-unavailable' });
    try {
      const live = liveCategoryTree(read.value.nodes, locale, locales.default);
      return ok({
        locale,
        defaultLocale: locales.default,
        categories: publicCategoryTree(
          live,
          read.value.details,
          read.value.liveCounts,
          locale,
          locales.default,
        ),
      });
    } catch (error) {
      if (error instanceof CategoryTreeUnavailableError) {
        return err({ code: 'catalog.categories-unavailable' });
      }
      throw error;
    }
  }
}
