import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_RESTRUCTURE } from '../../contracts/permissions';
import { PlatformCategoryMovedAudit } from '../../domain/audit';
import { planMove } from '../../domain/category-restructure';
import { PlatformCategoryMoved } from '../../domain/events';
import {
  categoryIdOf,
  closedInput,
  editorAccountOf,
  invalid,
  versionOf,
} from '../categories/category-editor';
import {
  reasonOf,
  runRestructure,
  type CategoryRestructureDependencies,
  type CategoryRestructureFailure,
  type CategoryRestructureRouteDependencies,
  type RestructureOutput,
  type RestructureSpec,
} from '../categories/category-restructure';
import type { EditableCategory } from '../../domain/category-edit';
import { categoryParentValues } from '../catalogue-actions';
import {
  CATEGORY_MOVE_SUBJECT_KIND,
  catalogueReview,
  isProposal,
  noteOr,
  openCatalogueReview,
  requestRef,
  type CatalogueRequestRef,
} from '../catalogue-review';

export interface CategoryMoveInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion', 'parentId', 'reason', 'note'] as const;

/**
 * `platform-category.move` (categories package C4a; catalog design 4.6; plan section 4): an admin
 * moves a category and its subtree under a new parent (`parentId` null: it becomes a department),
 * last among the new siblings, with a reason note. Refused for the same parent, a cycle, a subtree
 * deeper than `catalog.maxCategoryDepth`, a sibling name clash, products that would sit on level 1
 * or 2, certificate rules on the categories that leave the products' paths (C-4), and more tags
 * than `catalog.maxCategoryChangeTags`. Badges under the subtree are checked again (M1). Rule: the
 * protected key `catalog.category-tree.restructure`; refused in an acting-as session.
 *
 * It goes live at once and is reviewed after (area catalogue, owner decision of 18 Nov 2026):
 * where the Market reviews the area it needs a `note` (the reason note when none is given), and a
 * rejected or withdrawn move is moved back while the category is still under the new parent
 * (catalogue-structure-reverters.ts).
 */
export class CategoryMove extends UseCase<
  CategoryMoveInput,
  RestructureOutput,
  CategoryRestructureFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-move',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('CategoryMove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryRestructureRouteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryMoveInput,
  ): Promise<Result<RestructureOutput, CategoryRestructureFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-move',
      code: result.ok ? 'moved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryMoveInput,
  ): Promise<Result<RestructureOutput, CategoryRestructureFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const rawParent = body.value['parentId'];
    let parentId: Id<'Category'> | null = null;
    if (rawParent === undefined) return invalid('parentId', 'required');
    if (rawParent !== null) {
      const parsed = categoryIdOf(rawParent);
      if (!parsed.ok) return err({ code: 'category.parent-not-found' });
      parentId = parsed.value;
    }
    const reason = reasonOf(body.value['reason']);
    if (!reason.ok) return reason;
    const { market } = context;
    const maxDepth = this.deps.policy.maxCategoryDepth(market);
    // Its own read-only unit, before the change's (units do not nest).
    const policy = await catalogueReview(this.deps.review, context);

    const moved = await runRestructure(
      this.deps,
      context,
      moveSpec(this.deps, context, {
        accountId,
        targetId: id.value,
        parentId,
        treeVersion: treeVersion.value,
        reason: reason.value,
        maxDepth,
        requestId: null,
        // The move is live; its review opens in the same unit (a refusal rolls it back).
        opened: async (target) => {
          const review = await openCatalogueReview(this.deps.review, context, policy, {
            subjectKind: CATEGORY_MOVE_SUBJECT_KIND,
            subjectRef: target.id,
            before: categoryParentValues(target.parentId),
            after: categoryParentValues(parentId),
            note: noteOr(body.value['note'], reason.value),
            tooLargePath: 'parentId',
          });
          return review.ok ? ok(requestRef(review.value)) : err(review.error);
        },
      }),
    );
    if (!moved.ok) return moved;
    // A move never waits for approval: it files no proposal.
    if (isProposal(moved.value)) throw new Error('catalog: a move was proposed');
    return ok(moved.value);
  }
}

/**
 * The move of `targetId` under `parentId` as one restructure (shared by the route and by the
 * revert of a reviewed move, which moves it back naming the request in `requestId`): the plan, the
 * audit row and the `platform-category-moved` event; then `opened`, which opens the move's review
 * (the route) or answers no request (a revert).
 */
export function moveSpec(
  deps: Pick<CategoryRestructureDependencies, 'audit' | 'outbox' | 'clock'>,
  context: CallContext,
  move: {
    readonly accountId: Id<'Account'>;
    readonly targetId: Id<'Category'>;
    readonly parentId: Id<'Category'> | null;
    readonly treeVersion: number;
    readonly reason: string;
    readonly maxDepth: number;
    readonly requestId: Id<'SystemRequest'> | null;
    readonly opened: (
      target: EditableCategory,
    ) => Promise<Result<CatalogueRequestRef, CategoryRestructureFailure>>;
  },
): RestructureSpec {
  const { parentId } = move;
  return {
    accountId: move.accountId,
    targetId: move.targetId,
    treeVersion: move.treeVersion,
    reason: move.reason,
    kind: 'move',
    plan: (nodes, target, read) =>
      planMove(nodes, target, parentId, move.maxDepth, read.directProducts),
    finish: async ({ target, plan, tagsMarked, targetVersion }) => {
      await deps.audit.record(
        context,
        PlatformCategoryMovedAudit.entry(target.id, {
          before: { parentId: target.parentId, level: plan.levelBefore },
          after: {
            parentId,
            level: plan.levelAfter,
            subtreeSize: plan.affectedIds.length,
            tagsMarked,
            reasonGiven: true,
            requestId: move.requestId,
          },
        }),
      );
      await deps.outbox.append(context, [
        PlatformCategoryMoved.record({
          aggregateId: target.id,
          aggregateVersion: targetVersion,
          occurredAt: deps.clock.now(),
          payload: { categoryId: target.id, checkedIds: plan.retirementCheckIds },
        }),
      ]);
      return move.opened(target);
    },
  };
}
