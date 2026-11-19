import { Logger } from '@nestjs/common';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import {
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
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';
import { editDetailsInUnit } from '../categories/category-write-core';
import {
  categoryDetailsValues,
  catalogueReview,
  CATEGORY_DETAILS_SUBJECT_KIND,
  openCatalogueReview,
  requestRef,
  type CatalogueRequestRef,
} from '../catalogue-review';
import type { SystemRequestRecorder } from '../../../system-requests';

export interface CategoryEditDetailsDependencies extends CategoryWriteDependencies {
  /** Opens the review of the edit in Admin Inbox › System requests (area catalogue). */
  readonly review: SystemRequestRecorder;
}

/** What an edit answers: the category as written and the review it opened, if any. */
export interface CategoryEditDetailsOutput {
  readonly category: CategoryWriteView;
  readonly request: CatalogueRequestRef;
}

export interface CategoryEditDetailsInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'version', 'texts', 'seo', 'showInMenu', 'imageId', 'note'] as const;

/**
 * `platform-category.edit-details` (categories package C3a): an admin replaces the details of an
 * active or hidden category: a name, short description and keywords per locale, the English-only
 * search-result fields and the menu flag. The request is the whole content (a field left out is
 * cleared) and the category version the admin saw; a later version is `conflict.stale`. It makes
 * a new revision and announces the change; a save that changes nothing writes nothing. The slug
 * has its own use case, and so has the category image (C3c, `CategoryImageSet` and
 * `CategoryImageRemove`): a details save keeps the image, and a non-null `imageId` is refused
 * (`unsupported`). Rule: the key `catalog.category-tree.edit`.
 * Not a structural change: it does not raise the tree version.
 *
 * It goes live at once and is reviewed after (area catalogue, Admin Inbox › System requests):
 * where the Market reviews that area the request needs a `note` (1 to 500 characters), the edit
 * and its review commit together, and a rejected or withdrawn edit is restored by the reverter
 * in catalogue-reverters.ts.
 */
export class CategoryEditDetails extends UseCase<
  CategoryEditDetailsInput,
  CategoryEditDetailsOutput,
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-edit-details',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryEditDetails');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryEditDetailsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryEditDetailsInput,
  ): Promise<Result<CategoryEditDetailsOutput, CategoryWriteFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.category-edit-details',
      code: result.ok ? 'edited' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: CategoryEditDetailsInput,
  ): Promise<Result<CategoryEditDetailsOutput, CategoryWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const showInMenu = body.value['showInMenu'] ?? true;
    if (typeof showInMenu !== 'boolean') return invalid('showInMenu', 'type');
    const imageId = body.value['imageId'];
    if (imageId !== undefined && imageId !== null) return invalid('imageId', 'unsupported');
    const { market } = context;
    const { policy, store } = this.deps;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    let required: readonly string[];
    try {
      locales = policy.locales(market);
      required = requiredCategoryLocales(market, policy);
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
      checkedPlaces({ texts: texts.value, seo: seo.value }),
    );
    if (claim !== null) return err(claim);

    // Its own read-only unit, before this one (units do not nest).
    const reviewPolicy = await catalogueReview(this.deps.review, context);
    try {
      return await this.deps.unitOfWork.run<CategoryEditDetailsOutput, CategoryWriteFailure>(
        market,
        async () => {
          const nodes = await store.loadAll(market, MAX_TREE_NODES + 1);
          if (nodes.length > MAX_TREE_NODES) return err({ code: 'access.unavailable' } as const);
          const treeVersion = (await this.deps.categories.treeVersion(market)).version;
          const target = nodes.find((node) => node.id === id.value);
          const edited = await editDetailsInUnit(
            this.deps,
            context,
            accountId,
            nodes,
            id.value,
            { texts: texts.value, seo: seo.value, showInMenu, version: version.value },
            treeVersion,
          );
          if (!edited.ok) return edited;
          if (target === undefined) return err({ code: 'category.not-found' } as const);
          // The edit is live; its review opens in the same unit (a refusal rolls the edit back).
          const before = categoryDetailsValues(target.texts, target.seo, target.showInMenu);
          const after = categoryDetailsValues(texts.value, seo.value, showInMenu);
          const review = await openCatalogueReview(this.deps.review, context, reviewPolicy, {
            subjectKind: CATEGORY_DETAILS_SUBJECT_KIND,
            subjectRef: id.value,
            before,
            after,
            note: body.value['note'],
            tooLargePath: 'texts',
          });
          if (!review.ok) return err(review.error);
          return ok({ category: edited.value.category, request: requestRef(review.value) });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
