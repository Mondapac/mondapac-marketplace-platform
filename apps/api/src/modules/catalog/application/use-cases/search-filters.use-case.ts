import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  SearchFilterDefinition,
  SearchFilterUnavailable,
  SearchFiltersRequest,
} from '../../contracts/catalog-filters.facade';
import { isBrandSlug } from '../../domain/brand';
import { buildCategoryFilters, buildGlobalFilters } from '../../domain/search-filters';
import {
  chainOf,
  categoryIdOf,
  effectiveOf,
  CATEGORY_LINKS_LOAD_MAX,
} from '../attributes/category-links';
import type { CategoryAttributeLinkStore } from '../ports/category-attribute-link.store';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { SearchFilterReader } from '../ports/search-filter.reader';

/** The most brands and countries one request names (the page's own counts stay below). */
const MAX_NAMED = 500;
const TREE_LIMIT = 5000;

export interface SearchFiltersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly treeReader: CategoryTreeReader;
  readonly linkStore: CategoryAttributeLinkStore;
  readonly filterReader: SearchFilterReader;
}

/**
 * `catalog.search-filters`: the filters of a storefront listing (attributes A7). Rule
 * `anonymous`. With a category: the filter list its admin chose, the category's own after its
 * ancestors' (categories C8), each kept only while the attribute is active, allowed as a filter
 * and of a filterable type. Without one: the global Brand and Country of origin filters, whose
 * options are the brands and countries the caller names (the ones the index counted). A category
 * that is unknown has no filters; a tree or a read that fails is `catalog.filters-unavailable`,
 * never a half list. One read-only unit.
 */
export class SearchFiltersQuery extends UseCase<
  SearchFiltersRequest,
  readonly SearchFilterDefinition[],
  SearchFilterUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.search-filters',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SearchFiltersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SearchFiltersRequest,
  ): Promise<Result<readonly SearchFilterDefinition[], SearchFilterUnavailable>> {
    const { market } = context;
    if (typeof input.locale !== 'string' || input.locale.length === 0 || input.locale.length > 35) {
      return err({ code: 'catalog.filters-unavailable' });
    }
    const categoryId = input.categoryId === null ? null : categoryIdOf(input.categoryId);
    if (input.categoryId !== null && categoryId === null) return ok([]);
    const brandSlugs = [...new Set(input.brandSlugs)].filter(isBrandSlug).slice(0, MAX_NAMED);
    const countryCodes = [...new Set(input.countryCodes)].slice(0, MAX_NAMED);
    try {
      return await this.deps.unitOfWork.run<
        readonly SearchFilterDefinition[],
        SearchFilterUnavailable
      >(
        market,
        async () => {
          if (categoryId === null) {
            const brands = await this.deps.filterReader.brands(market, brandSlugs);
            return ok(buildGlobalFilters({ brands, countryCodes }));
          }
          const nodes = await this.deps.treeReader.nodes(market, TREE_LIMIT);
          const chain = chainOf(categoryId, nodes);
          if (chain === null) return ok([]);
          const links = await this.deps.linkStore.all(market, CATEGORY_LINKS_LOAD_MAX);
          const codes = effectiveOf(chain, links).filters.map((filter) => filter.code);
          const definitions = await this.deps.filterReader.definitions(market, codes);
          return ok(buildCategoryFilters({ codes, definitions, locale: input.locale }));
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'catalog.filters-unavailable' });
    }
  }
}
