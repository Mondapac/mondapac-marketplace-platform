import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SystemRequestRecorder } from '../../../system-requests';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import {
  categoryIdOf,
  closedInput,
  editorAccountOf,
  invalid,
  runStructural,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';
import { reorderInUnit } from '../categories/category-write-core';
import { reorderValues } from '../catalogue-actions';
import {
  CATEGORY_REORDER_SUBJECT_KIND,
  catalogueReview,
  openCatalogueReview,
  requestRef,
  type CatalogueRequestRef,
} from '../catalogue-review';

export interface CategoryReorderInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'direction', 'treeVersion', 'note'] as const;

export interface CategoryReorderDependencies extends CategoryWriteDependencies {
  /** Opens the review of the reorder in Admin Inbox › System requests (area catalogue). */
  readonly review: SystemRequestRecorder;
}

export interface CategoryReorderOutput {
  readonly category: CategoryWriteView;
  readonly request: CatalogueRequestRef;
}

/**
 * `platform-category.reorder` (categories package C3a; Move up and Move down): an admin swaps a
 * category with the sibling above or below it. Only the order among siblings changes, so it is not
 * structural for certification, but it does raise the tree version like every tree write: a page
 * that showed the old order must reload. Each of the two categories gets a `reordered` revision.
 * `category.reorder-edge` when there is no sibling in that direction. Rule: the key
 * `catalog.category-tree.edit`.
 *
 * It goes live at once and is reviewed after (area catalogue, owner decision of 18 Nov 2026):
 * where the Market reviews the area the request needs a `note`, and a rejected or withdrawn
 * reorder is swapped back while both categories still hold the places it gave them.
 */
export class CategoryReorder extends UseCase<
  CategoryReorderInput,
  CategoryReorderOutput,
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-reorder',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryReorder');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryReorderDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryReorderInput,
  ): Promise<Result<CategoryReorderOutput, CategoryWriteFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-reorder',
      code: result.ok ? 'reordered' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryReorderInput,
  ): Promise<Result<CategoryReorderOutput, CategoryWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const { market } = context;
    const direction = body.value['direction'];
    if (direction !== 'up' && direction !== 'down') return invalid('direction', 'unknown');
    // Its own read-only unit, before this one (units do not nest).
    const policy = await catalogueReview(this.deps.review, context);
    return runStructural(this.deps, market, treeVersion.value, async (nodes, nextTreeVersion) => {
      const done = await reorderInUnit(
        this.deps,
        context,
        accountId,
        nodes,
        id.value,
        direction,
        nextTreeVersion,
        null,
      );
      if (!done.ok) return done;
      const { target, neighbour } = done.value;
      const review = await openCatalogueReview(this.deps.review, context, policy, {
        subjectKind: CATEGORY_REORDER_SUBJECT_KIND,
        subjectRef: target.id,
        before: reorderValues({
          position: target.position,
          neighbourId: neighbour.id,
          neighbourPosition: neighbour.position,
        }),
        after: reorderValues({
          position: neighbour.position,
          neighbourId: neighbour.id,
          neighbourPosition: target.position,
        }),
        note: body.value['note'],
        tooLargePath: 'direction',
      });
      if (!review.ok) return err(review.error);
      return ok({ category: done.value.category, request: requestRef(review.value) });
    });
  }
}
