import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
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
import { categoryActionValues, categoryStateValues } from '../catalogue-actions';
import {
  CATEGORY_RESTRUCTURE_SUBJECT_KIND,
  catalogueReview,
  noteOr,
  proposeCatalogueAction,
  type ProposedOr,
} from '../catalogue-review';

export interface CategoryMergeInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion', 'targetId', 'reason', 'note'] as const;

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
 *
 * Where the Market reviews area catalogue it waits for a second admin's approval (owner decision
 * of 18 Nov 2026): after the same plan and certificate check, the answer is the proposal
 * (`request`; the `note`, or the reason note when none is given) and nothing is written. The
 * approval runs {@link mergeSpec} again (catalogue-appliers.ts).
 */
export class CategoryMerge extends UseCase<
  CategoryMergeInput,
  ProposedOr<RestructureOutput>,
  CategoryRestructureFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-merge',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('CategoryMerge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryRestructureRouteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryMergeInput,
  ): Promise<Result<ProposedOr<RestructureOutput>, CategoryRestructureFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-merge',
      code: result.ok ? ('category' in result.value ? 'merged' : 'proposed') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryMergeInput,
  ): Promise<Result<ProposedOr<RestructureOutput>, CategoryRestructureFailure>> {
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
    // Its own read-only unit, before the change's (units do not nest).
    const policy = await catalogueReview(this.deps.review, context);

    return runRestructure(
      this.deps,
      context,
      mergeSpec(this.deps, context, {
        accountId,
        sourceId: id.value,
        targetId: targetId.value,
        treeVersion: treeVersion.value,
        reason: reason.value,
        maxDepth,
        requestId: null,
      }),
      {
        reviewed: policy.reviewed,
        propose: (source) =>
          proposeCatalogueAction(this.deps.proposer, context, policy, {
            subjectKind: CATEGORY_RESTRUCTURE_SUBJECT_KIND,
            subjectRef: source.id,
            before: categoryStateValues(source),
            after: categoryActionValues({
              action: 'merge',
              targetId: targetId.value,
              reason: reason.value,
            }),
            note: noteOr(body.value['note'], reason.value),
            tooLargePath: 'reason',
          }),
      },
    );
  }
}

/**
 * The merge of `sourceId` into `targetId` as one restructure (shared by the route and by the
 * approval of a proposed merge, which names its request in `requestId`): the plan, the business
 * activities relinked, the audit row and the `platform-category-merged` event.
 */
export function mergeSpec(
  deps: Pick<CategoryRestructureDependencies, 'audit' | 'outbox' | 'clock' | 'restructure'>,
  context: CallContext,
  merge: {
    readonly accountId: Id<'Account'>;
    readonly sourceId: Id<'Category'>;
    readonly targetId: Id<'Category'>;
    readonly treeVersion: number;
    readonly reason: string;
    readonly maxDepth: number;
    readonly requestId: Id<'SystemRequest'> | null;
  },
): RestructureSpec {
  const { market } = context;
  const { targetId } = merge;
  return {
    accountId: merge.accountId,
    targetId: merge.sourceId,
    treeVersion: merge.treeVersion,
    reason: merge.reason,
    kind: 'merge',
    plan: (nodes, source, read) =>
      planMerge(nodes, source, targetId, merge.maxDepth, read.directProducts),
    finish: async ({ target: source, plan, tagsMarked, targetVersion }) => {
      const relinked = await deps.restructure.relinkActivities(
        market,
        source.id,
        targetId,
        deps.clock.now(),
      );
      await deps.audit.record(
        context,
        PlatformCategoryMergedAudit.entry(source.id, {
          before: { status: source.status === 'hidden' ? 'hidden' : 'active' },
          after: {
            mergedIntoId: targetId,
            childrenMoved: plan.changes.filter((change) => change.parentId !== undefined).length,
            activitiesRelinked: relinked,
            tagsMarked,
            reasonGiven: true,
            requestId: merge.requestId,
          },
        }),
      );
      await deps.outbox.append(context, [
        PlatformCategoryMerged.record({
          aggregateId: source.id,
          aggregateVersion: targetVersion,
          occurredAt: deps.clock.now(),
          payload: {
            categoryId: source.id,
            mergedIntoId: targetId,
            checkedIds: plan.retirementCheckIds,
          },
        }),
      ]);
      return ok(null);
    },
  };
}
