import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { adminCategoryTree } from '../../domain/category-admin-tree';
import { CategoryTreeUnavailableError, MAX_TREE_NODES } from '../../domain/category-tree';
import { CATALOG_CATEGORY_TREE_VIEW } from '../../contracts/permissions';
import { FEATURE_SET_LOAD_MAX } from '../attributes/attribute-admin-views';
import { CATEGORY_LINKS_LOAD_MAX, effectiveFeatureSetsOf } from '../attributes/category-links';
import {
  CATEGORY_COUNT_BUDGET_MS,
  categoryActions,
  closedInput,
  invalid,
  requiredCategoryLocales,
  rowViewOf,
  type ActionMap,
  type CategoryActionProbes,
  type CategoryRowView,
  type ValidationFailure,
} from '../categories/category-admin-views';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryAttributeLinkStore } from '../ports/category-attribute-link.store';

/** The query of the admin list: every key is optional. */
export interface CategoryAdminTreeInput {
  /** Only the categories whose effective feature set is this one (a UUID). */
  readonly featureSetId?: unknown;
}

/**
 * One row of the admin list: the row of the tree plus the feature set it ends up with, resolved by
 * the attribute-links inheritance rule (the same one `category-attribute-links.get` answers).
 */
export interface CategoryTreeRowView extends CategoryRowView {
  /** The effective feature set; null when neither the category nor an ancestor holds one. */
  readonly featureSetId: string | null;
  /** Its code; null when there is no feature set or it is not readable as a published set. */
  readonly featureSetCode: string | null;
  /** The category that holds it: this one, or the nearest ancestor that does. */
  readonly featureSetFromCategoryId: string | null;
  /** True when the feature set comes from an ancestor; false when it is the category's own or none. */
  readonly inherited: boolean;
}

export interface CategoryAdminTreeOutput {
  /** `category_trees.version`: what a structural change must name (C3 on). */
  readonly treeVersion: number;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  /** The locales every category needs a name in. */
  readonly requiredLocales: readonly string[];
  /** False when the counts hit their time bound: they are then "at least". */
  readonly complete: boolean;
  /** Depth first, siblings in order; with `featureSetId`, only the rows whose effective set it is. */
  readonly categories: readonly CategoryTreeRowView[];
  readonly actions: ActionMap;
}

export type CategoryAdminTreeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'catalog.categories-unavailable' }
  | ValidationFailure;

export interface CategoryAdminTreeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminCategoryReader: AdminCategoryReader;
  readonly policy: CatalogMarketPolicy;
  readonly categoryProbes: CategoryActionProbes;
  readonly linkStore: Pick<CategoryAttributeLinkStore, 'all'>;
  readonly attributeAdminReader: Pick<AttributeAdminReader, 'featureSets'>;
}

/**
 * `category-tree.admin-list` (categories package C1): the whole platform category tree of the
 * Market for the admin page, in any status, with names per locale, depth, place among siblings and
 * the counts of live products and Offers. One read-only unit; the counts are bounded at 10 seconds
 * and then `complete` is false. A tree that cannot be built is `catalog.categories-unavailable`,
 * never a partial tree. Each row carries its effective feature set, resolved for the whole tree from
 * one read of the links and one of the feature sets (no read per category); `featureSetId` keeps
 * only the rows that end up with that set. Rule: the key `catalog.category-tree.view` and the admin
 * population.
 */
export class CategoryAdminTree extends UseCase<
  CategoryAdminTreeInput,
  CategoryAdminTreeOutput,
  CategoryAdminTreeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-admin-tree',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_VIEW.key] },
  };

  readonly #logger = new Logger('CategoryAdminTree');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryAdminTreeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryAdminTreeInput,
  ): Promise<Result<CategoryAdminTreeOutput, CategoryAdminTreeFailure>> {
    const result = await this.#read(context, input);
    this.#logger.log({
      msg: 'catalog.category-admin-tree',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #read(
    context: CallContext,
    input: CategoryAdminTreeInput,
  ): Promise<Result<CategoryAdminTreeOutput, CategoryAdminTreeFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input ?? {}, ['featureSetId']);
    if (!body.ok) return body;
    let only: Id<'AttributeFamily'> | null = null;
    const rawFilter = body.value['featureSetId'];
    if (rawFilter !== undefined) {
      const parsed = typeof rawFilter === 'string' ? parseId<'AttributeFamily'>(rawFilter) : null;
      if (parsed === null || !parsed.ok) return invalid('featureSetId', 'format');
      only = parsed.value;
    }
    const { market } = context;
    const { policy } = this.deps;
    const locales = policy.locales(market);
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        // One after the other: the unit holds one connection.
        const { adminCategoryReader } = this.deps;
        const nodes = await adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
        const treeVersion = await adminCategoryReader.treeVersion(market);
        const counted = await adminCategoryReader.productFacts(market, CATEGORY_COUNT_BUDGET_MS);
        const links = await this.deps.linkStore.all(market, CATEGORY_LINKS_LOAD_MAX + 1);
        if (links.length > CATEGORY_LINKS_LOAD_MAX) return ok(null);
        // The codes only: one read of the Market's feature sets, and none when no category has one.
        const families = links.some((link) => link.familyId !== null)
          ? await this.deps.attributeAdminReader.featureSets(market, FEATURE_SET_LOAD_MAX)
          : [];
        return ok({ nodes, treeVersion, counted, links, families });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'catalog.categories-unavailable' });
    const { nodes, treeVersion, counted, links, families } = read.value;
    let rows;
    try {
      rows = adminCategoryTree(nodes, locales.default, counted.facts);
    } catch (error) {
      if (error instanceof CategoryTreeUnavailableError) {
        return err({ code: 'catalog.categories-unavailable' });
      }
      throw error;
    }
    const effective = effectiveFeatureSetsOf(nodes, links);
    if (effective === null) return err({ code: 'catalog.categories-unavailable' });
    const codes = new Map(families.map((family) => [family.id as string, family.code]));
    const categories = rows.flatMap((row): CategoryTreeRowView[] => {
      const set = effective.get(row.id);
      const familyId = set?.familyId ?? null;
      if (only !== null && familyId !== only) return [];
      const fromCategoryId = familyId === null ? null : (set?.fromCategoryId ?? null);
      return [
        {
          ...rowViewOf(row),
          featureSetId: familyId,
          featureSetCode: familyId === null ? null : (codes.get(familyId) ?? null),
          featureSetFromCategoryId: fromCategoryId,
          inherited: fromCategoryId !== null && fromCategoryId !== row.id,
        },
      ];
    });
    return ok({
      treeVersion,
      defaultLocale: locales.default,
      supportedLocales: [...locales.supported],
      requiredLocales: [...requiredCategoryLocales(market, policy)],
      complete: counted.complete,
      categories,
      actions: await categoryActions(context, this.deps.categoryProbes, null),
    });
  }
}
