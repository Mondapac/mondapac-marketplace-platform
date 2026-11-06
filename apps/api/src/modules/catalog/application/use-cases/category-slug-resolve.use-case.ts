import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CategoryTreeUnavailableError,
  liveCategoryTree,
  MAX_TREE_NODES,
} from '../../domain/category-tree';
import { CATEGORY_SLUG } from '../../domain/category-edit';
import { resolveCategorySlug, type CategorySlugResolution } from '../../domain/public-category';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { PublicCategoryReader } from '../ports/public-category.reader';

export interface CategorySlugResolveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly treeReader: CategoryTreeReader;
  readonly publicCategories: PublicCategoryReader;
  readonly policy: CatalogMarketPolicy;
}

export interface CategorySlugResolveInput {
  /** Checked against the slug pattern by the domain; anything else is not found. */
  readonly slug: string;
}

export type CategorySlugResolveFailure =
  | { readonly code: 'catalog.category-not-found' }
  | { readonly code: 'catalog.categories-unavailable' };

export type CategorySlugResolveAnswer = Exclude<CategorySlugResolution, { kind: 'not-found' }>;

/**
 * `catalog.category-slug-resolve` (categories C6a; plan decisions 9 and 10): what the buyer
 * site's `/c/{slug}` shows. A live category of the request's Market, or the slug to redirect to
 * (retired slugs and merges permanently, a hidden category temporarily to its nearest shown
 * ancestor), or `catalog.category-not-found`. A slug of another Market, an unknown slug and a
 * slug that leads nowhere give the same not-found. Rule `anonymous`, one read-only unit.
 */
export class CategorySlugResolveQuery extends UseCase<
  CategorySlugResolveInput,
  CategorySlugResolveAnswer,
  CategorySlugResolveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-slug-resolve',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategorySlugResolveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategorySlugResolveInput,
  ): Promise<Result<CategorySlugResolveAnswer, CategorySlugResolveFailure>> {
    const { market } = context;
    // A value that is not a slug names nothing: answered before any read.
    if (!CATEGORY_SLUG.test(input.slug)) return err({ code: 'catalog.category-not-found' });
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const nodes = await this.deps.treeReader.nodes(market, MAX_TREE_NODES + 1);
        const held = nodes.some((node) => node.slug === input.slug);
        const history = held
          ? null
          : await this.deps.publicCategories.slugHistory(market, input.slug);
        return ok({ nodes, history });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'catalog.categories-unavailable' });
    let liveIds: ReadonlySet<Id<'Category'>>;
    try {
      const locale = this.deps.policy.locales(market).default;
      liveIds = new Set(liveCategoryTree(read.value.nodes, locale).map((node) => node.id));
    } catch (error) {
      if (error instanceof CategoryTreeUnavailableError) {
        return err({ code: 'catalog.categories-unavailable' });
      }
      throw error;
    }
    const answer = resolveCategorySlug(input.slug, read.value.nodes, liveIds, (slug) =>
      slug === input.slug ? read.value.history : null,
    );
    if (answer.kind === 'not-found') return err({ code: 'catalog.category-not-found' });
    return ok(answer);
  }
}
