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

export interface CategoryEditDetailsInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'version', 'texts', 'seo', 'showInMenu', 'imageId'] as const;

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
 */
export class CategoryEditDetails extends UseCase<
  CategoryEditDetailsInput,
  { readonly category: CategoryWriteView },
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-edit-details',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryEditDetails');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryEditDetailsInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
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
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
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

    try {
      return await this.deps.unitOfWork.run<
        { readonly category: CategoryWriteView },
        CategoryWriteFailure
      >(market, async () => {
        const nodes = await store.loadAll(market, MAX_TREE_NODES + 1);
        if (nodes.length > MAX_TREE_NODES) return err({ code: 'access.unavailable' } as const);
        const treeVersion = (await this.deps.categories.treeVersion(market)).version;
        const edited = await editDetailsInUnit(
          this.deps,
          context,
          accountId,
          nodes,
          id.value,
          { texts: texts.value, seo: seo.value, showInMenu, version: version.value },
          treeVersion,
        );
        return edited.ok ? ok({ category: edited.value.category }) : edited;
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
