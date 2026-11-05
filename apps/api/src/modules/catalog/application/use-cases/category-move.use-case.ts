import { Logger } from '@nestjs/common';
import { err } from '@mondapac/shared-kernel';
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
  type CategoryWriteView,
} from '../categories/category-editor';
import {
  reasonOf,
  runRestructure,
  type CategoryRestructureDependencies,
  type CategoryRestructureFailure,
} from '../categories/category-restructure';

export interface CategoryMoveInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion', 'parentId', 'reason'] as const;

/**
 * `platform-category.move` (categories package C4a; catalog design 4.6; plan section 4): an admin
 * moves a category and its subtree under a new parent (`parentId` null: it becomes a department),
 * last among the new siblings, with a reason note. Refused for the same parent, a cycle, a subtree
 * deeper than `catalog.maxCategoryDepth`, a sibling name clash, products that would sit on level 1
 * or 2, certificate rules on the categories that leave the products' paths (C-4), and more tags
 * than `catalog.maxCategoryChangeTags`. Badges under the subtree are checked again (M1). Rule: the
 * protected key `catalog.category-tree.restructure`; refused in an acting-as session.
 */
export class CategoryMove extends UseCase<
  CategoryMoveInput,
  { readonly category: CategoryWriteView },
  CategoryRestructureFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-move',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('CategoryMove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryRestructureDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryMoveInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryRestructureFailure>> {
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
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryRestructureFailure>> {
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

    return runRestructure(this.deps, context, {
      accountId,
      targetId: id.value,
      treeVersion: treeVersion.value,
      reason: reason.value,
      plan: (nodes, target, read) =>
        planMove(nodes, target, parentId, maxDepth, read.directProducts),
      finish: async ({ target, plan, tagsMarked, targetVersion }) => {
        await this.deps.audit.record(
          context,
          PlatformCategoryMovedAudit.entry(target.id, {
            before: { parentId: target.parentId, level: plan.levelBefore },
            after: {
              parentId,
              level: plan.levelAfter,
              subtreeSize: plan.affectedIds.length,
              tagsMarked,
              reasonGiven: true,
            },
          }),
        );
        await this.deps.outbox.append(context, [
          PlatformCategoryMoved.record({
            aggregateId: target.id,
            aggregateVersion: targetVersion,
            occurredAt: this.deps.clock.now(),
            payload: { categoryId: target.id, checkedIds: plan.retirementCheckIds },
          }),
        ]);
      },
    });
  }
}
