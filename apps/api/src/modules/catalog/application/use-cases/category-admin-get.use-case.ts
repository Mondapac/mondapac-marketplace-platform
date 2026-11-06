import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CategorySeo, CategoryText } from '../../domain/category-edit';
import { adminCategoryTree, categoryNameIn, categoryPath } from '../../domain/category-admin-tree';
import { CategoryTreeUnavailableError, MAX_TREE_NODES } from '../../domain/category-tree';
import { CATALOG_CATEGORY_TREE_VIEW } from '../../contracts/permissions';
import {
  CATEGORY_COUNT_BUDGET_MS,
  CATEGORY_HISTORY_LIMIT,
  categoryActions,
  categoryIdOf,
  closedInput,
  requiredCategoryLocales,
  rowViewOf,
  type ActionMap,
  type CategoryActionProbes,
  type CategoryRowView,
  type ValidationFailure,
} from '../categories/category-admin-views';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface CategoryAdminGetInput {
  readonly categoryId: unknown;
}

export interface CategoryPathEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string | null;
}

export interface CategoryRevisionView {
  readonly revisionNo: number;
  readonly changeKind: string;
  readonly authorKind: 'seed' | 'admin';
  /** Null for the seed. */
  readonly authorAccountId: string | null;
  readonly parentId: string | null;
  readonly names: readonly { readonly locale: string; readonly name: string }[];
  readonly createdAt: string;
}

export interface CategoryAdminGetOutput {
  readonly category: CategoryRowView;
  /** Root first, the category itself last. */
  readonly path: readonly CategoryPathEntry[];
  readonly requiredLocales: readonly string[];
  /** Required locales this category has no name in. */
  readonly missingLocales: readonly string[];
  /** Newest first, at most 200. */
  readonly revisions: readonly CategoryRevisionView[];
  readonly complete: boolean;
  readonly actions: ActionMap;
  /** What the edit form starts from: the whole text per locale and the flags. */
  readonly details: {
    readonly texts: readonly CategoryText[];
    readonly seo: CategorySeo;
    readonly showInMenu: boolean;
    readonly imageId: string | null;
    readonly hiddenById: string | null;
  };
  /** `category_trees.version`: what a structural change of this category must name. */
  readonly treeVersion: number;
}

export type CategoryAdminGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'category.not-found' }
  | { readonly code: 'catalog.categories-unavailable' }
  | ValidationFailure;

export interface CategoryAdminGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminCategoryReader: AdminCategoryReader;
  readonly policy: CatalogMarketPolicy;
  readonly categoryProbes: CategoryActionProbes;
}

/**
 * `category-tree.admin-get` (categories package C1): one category of any status with its path, its
 * counts, its revision history and what the caller may do with it (the ID 8.6 pattern). A malformed
 * id, an unknown id and the id of another Market are the same `category.not-found`. Rule: the key
 * `catalog.category-tree.view` and the admin population.
 */
export class CategoryAdminGet extends UseCase<
  CategoryAdminGetInput,
  CategoryAdminGetOutput,
  CategoryAdminGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-admin-get',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_VIEW.key] },
  };

  readonly #logger = new Logger('CategoryAdminGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryAdminGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryAdminGetInput,
  ): Promise<Result<CategoryAdminGetOutput, CategoryAdminGetFailure>> {
    const result = await this.#read(context, input);
    this.#logger.log({
      msg: 'catalog.category-admin-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #read(
    context: CallContext,
    input: CategoryAdminGetInput,
  ): Promise<Result<CategoryAdminGetOutput, CategoryAdminGetFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, ['categoryId']);
    if (!body.ok) return err({ code: 'category.not-found' });
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return id;
    const { market } = context;
    const { policy, adminCategoryReader } = this.deps;
    const locales = policy.locales(market);
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const nodes = await adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
        if (!nodes.some((node) => node.id === id.value)) return ok(null);
        const counted = await adminCategoryReader.productFacts(market, CATEGORY_COUNT_BUDGET_MS);
        const revisions = await adminCategoryReader.revisions(
          market,
          id.value,
          CATEGORY_HISTORY_LIMIT,
        );
        const detail = await adminCategoryReader.detail(market, id.value);
        const treeVersion = await adminCategoryReader.treeVersion(market);
        if (detail === null) return ok(null);
        return ok({ nodes, counted, revisions, detail, treeVersion });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'category.not-found' });
    const { nodes, counted, revisions, detail, treeVersion } = read.value;
    let row;
    let path;
    try {
      row = adminCategoryTree(nodes, locales.default, counted.facts).find(
        (entry) => entry.id === id.value,
      );
      path = categoryPath(nodes, id.value);
    } catch (error) {
      if (error instanceof CategoryTreeUnavailableError) {
        return err({ code: 'catalog.categories-unavailable' });
      }
      throw error;
    }
    if (row === undefined) return err({ code: 'category.not-found' });
    const required = requiredCategoryLocales(market, policy);
    return ok({
      category: rowViewOf(row),
      path: path.map((node) => ({
        id: node.id,
        slug: node.slug,
        name: categoryNameIn(node.names, locales.default),
      })),
      requiredLocales: [...required],
      missingLocales: required.filter((locale) => !row.names.some((n) => n.locale === locale)),
      revisions: revisions.map((revision) => ({
        revisionNo: revision.revisionNo,
        changeKind: revision.changeKind,
        authorKind: revision.authorKind,
        authorAccountId: revision.authorAccountId,
        parentId: revision.parentId,
        names: revision.names,
        createdAt: revision.createdAt.toString(),
      })),
      complete: counted.complete,
      actions: await categoryActions(context, this.deps.categoryProbes, row.status),
      details: {
        texts: detail.texts,
        seo: detail.seo,
        showInMenu: detail.showInMenu,
        imageId: detail.imageId,
        hiddenById: detail.hiddenById,
      },
      treeVersion,
    });
  }
}
