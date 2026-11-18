import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import {
  isCategorySlug,
  blockedCategoryFields,
  parseCategorySeo,
  parseCategoryTexts,
} from '../../domain/category-edit';
import {
  categoryIdOf,
  checkedPlaces,
  closedInput,
  editorAccountOf,
  invalid,
  refuseClaimTexts,
  requiredCategoryLocales,
  runStructural,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';
import { createCategoryInUnit } from '../categories/category-write-core';
import { categoryCreatedValues, NOTHING_BEFORE } from '../catalogue-actions';
import {
  CATEGORY_CREATE_SUBJECT_KIND,
  catalogueReview,
  openCatalogueReview,
  requestRef,
  type CatalogueRequestRef,
} from '../catalogue-review';
import type { SystemRequestRecorder } from '../../../system-requests';

export interface CategoryCreateInput {
  readonly [key: string]: unknown;
}

const KEYS = ['parentId', 'slug', 'texts', 'seo', 'showInMenu', 'treeVersion', 'note'] as const;

export interface CategoryCreateDependencies extends CategoryWriteDependencies {
  /** Opens the review of the new category in Admin Inbox › System requests (area catalogue). */
  readonly review: SystemRequestRecorder;
}

export interface CategoryCreateOutput {
  readonly category: CategoryWriteView;
  readonly request: CatalogueRequestRef;
}

/**
 * `platform-category.create` (categories package C3a; plan decision 5): an admin adds a category
 * or a child. It is created `hidden`, last among its siblings, and goes live with Show. The slug
 * is the one given: unique in the Market, not retired from another category in the last 12
 * months; the level may not pass the Market's `maxCategoryDepth`; two siblings may not share a
 * name in a locale. The default locale's name is required; every text passes the claim-text
 * check in its own locale and a locale the check cannot read is refused (fail closed). A
 * structural write: it names the tree version the page read. Rule: the key
 * `catalog.category-tree.edit`, the admin population, never an acting-as session.
 *
 * It goes live at once and is reviewed after (area catalogue, owner decision of 18 Nov 2026):
 * where the Market reviews the area the request needs a `note`; a rejected or withdrawn create is
 * discarded while the category never went live, else hidden (catalogue-structure-reverters.ts).
 */
export class CategoryCreate extends UseCase<
  CategoryCreateInput,
  CategoryCreateOutput,
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-create',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryCreateInput,
  ): Promise<Result<CategoryCreateOutput, CategoryWriteFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.category-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: CategoryCreateInput,
  ): Promise<Result<CategoryCreateOutput, CategoryWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const { market } = context;
    const { policy } = this.deps;

    const rawParent = body.value['parentId'];
    let parentId: Id<'Category'> | null = null;
    if (rawParent !== undefined && rawParent !== null) {
      const parsed = categoryIdOf(rawParent);
      if (!parsed.ok) return err({ code: 'category.parent-not-found' });
      parentId = parsed.value;
    }
    const slug = body.value['slug'];
    if (!isCategorySlug(slug)) return invalid('slug', 'format');
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const showInMenu = body.value['showInMenu'] ?? true;
    if (typeof showInMenu !== 'boolean') return invalid('showInMenu', 'type');

    let locales: { readonly default: string; readonly supported: readonly string[] };
    let required: readonly string[];
    let maxDepth: number;
    try {
      locales = policy.locales(market);
      required = requiredCategoryLocales(market, policy);
      maxDepth = policy.maxCategoryDepth(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const texts = parseCategoryTexts(body.value['texts'], {
      supported: locales.supported,
      required,
    });
    if (!texts.ok) return texts;
    const seo = parseCategorySeo(body.value['seo']);
    if (!seo.ok) return seo;
    const blocked = blockedCategoryFields(texts.value, seo.value, (text) =>
      this.deps.contentFilter.isBlocked(market, text),
    );
    if (!blocked.ok) return blocked;

    const claim = await refuseClaimTexts(
      this.deps,
      context,
      checkedPlaces({
        texts: texts.value,
        seo: seo.value,
        slug,
      }),
    );
    if (claim !== null) return err(claim);

    // Its own read-only unit, before this one (units do not nest).
    const reviewPolicy = await catalogueReview(this.deps.review, context);
    return runStructural(this.deps, market, treeVersion.value, async (nodes, nextTreeVersion) => {
      const created = await createCategoryInUnit(
        this.deps,
        context,
        accountId,
        nodes,
        { parentId, slug, texts: texts.value, seo: seo.value, showInMenu, maxDepth },
        nextTreeVersion,
      );
      if (!created.ok) return created;
      // The category is live (hidden); its review opens in the same unit.
      const review = await openCatalogueReview(this.deps.review, context, reviewPolicy, {
        subjectKind: CATEGORY_CREATE_SUBJECT_KIND,
        subjectRef: created.value.node.id,
        before: NOTHING_BEFORE,
        after: categoryCreatedValues({ slug, parentId }),
        note: body.value['note'],
        tooLargePath: 'slug',
      });
      if (!review.ok) return err(review.error);
      return ok({ category: created.value.category, request: requestRef(review.value) });
    });
  }
}
