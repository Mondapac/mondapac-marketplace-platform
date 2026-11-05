import { Logger } from '@nestjs/common';
import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_RESTRUCTURE } from '../../contracts/permissions';
import { PlatformCategoryMergedAudit } from '../../domain/audit';
import { planMerge } from '../../domain/category-restructure';
import { PlatformCategoryMerged } from '../../domain/events';
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

export interface CategoryMergeInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion', 'targetId', 'reason'] as const;

/**
 * `platform-category.merge` (categories package C4a; catalog design 4.6; plan section 4): an admin
 * merges a category into another. Its live children move under the target (last, in their order);
 * the category becomes `merged` and keeps its slug, which resolves to the target (C6); sellers'
 * business activities that named it now name the target. Refused into itself or its own
 * descendant, past `catalog.maxCategoryDepth`, on a child's name clash, products on level 1 or 2,
 * certificate rules on the retired categories (C-4) and more tags than
 * `catalog.maxCategoryChangeTags`. Badges under it are checked again (M1); the own handler of the
 * event calls certification's backstop. Rule: the protected key `catalog.category-tree.restructure`;
 * refused in an acting-as session.
 */
export class CategoryMerge extends UseCase<
  CategoryMergeInput,
  { readonly category: CategoryWriteView },
  CategoryRestructureFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-merge',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('CategoryMerge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryRestructureDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryMergeInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryRestructureFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-merge',
      code: result.ok ? 'merged' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryMergeInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryRestructureFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    if (body.value['targetId'] === undefined) return invalid('targetId', 'required');
    const targetId = categoryIdOf(body.value['targetId']);
    if (!targetId.ok) return err({ code: 'category.target-not-found' });
    const reason = reasonOf(body.value['reason']);
    if (!reason.ok) return reason;
    const { market } = context;
    const maxDepth = this.deps.policy.maxCategoryDepth(market);

    return runRestructure(this.deps, context, {
      accountId,
      targetId: id.value,
      treeVersion: treeVersion.value,
      reason: reason.value,
      plan: (nodes, source, read) =>
        planMerge(nodes, source, targetId.value, maxDepth, read.directProducts),
      finish: async ({ target: source, plan, tagsMarked, targetVersion }) => {
        const relinked = await this.deps.restructure.relinkActivities(
          market,
          source.id,
          targetId.value,
          this.deps.clock.now(),
        );
        await this.deps.audit.record(
          context,
          PlatformCategoryMergedAudit.entry(source.id, {
            before: { status: source.status === 'hidden' ? 'hidden' : 'active' },
            after: {
              mergedIntoId: targetId.value,
              childrenMoved: plan.changes.filter((change) => change.parentId !== undefined).length,
              activitiesRelinked: relinked,
              tagsMarked,
              reasonGiven: true,
            },
          }),
        );
        await this.deps.outbox.append(context, [
          PlatformCategoryMerged.record({
            aggregateId: source.id,
            aggregateVersion: targetVersion,
            occurredAt: this.deps.clock.now(),
            payload: {
              categoryId: source.id,
              mergedIntoId: targetId.value,
              checkedIds: plan.retirementCheckIds,
            },
          }),
        ]);
      },
    });
  }
}
