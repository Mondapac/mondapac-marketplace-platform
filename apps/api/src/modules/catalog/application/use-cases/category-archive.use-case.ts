import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_RESTRUCTURE } from '../../contracts/permissions';
import { PlatformCategoryArchivedAudit } from '../../domain/audit';
import { planArchive } from '../../domain/category-restructure';
import { PlatformCategoryArchived } from '../../domain/events';
import {
  categoryIdOf,
  closedInput,
  editorAccountOf,
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

export interface CategoryArchiveInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion', 'reason', 'note'] as const;

/**
 * `platform-category.archive` (categories package C4a; catalog design 4.6; plan decision 7): an
 * admin archives a category with no live subcategory. Terminal: there is no restore (use Hide to
 * pause). It leaves the products' paths; its slug resolves to the parent (C6); sellers' business
 * activities stop naming it. Refused while a published product would be left with no live
 * platform category (AC 4: `category.only-platform-category` with the count), on certificate
 * rules (C-4) and above `catalog.maxCategoryChangeTags` tags. Badges are checked again (M1); the
 * own handler of the event calls certification's backstop. Rule: the protected key
 * `catalog.category-tree.restructure`; refused in an acting-as session.
 *
 * Where the Market reviews area catalogue it waits for a second admin's approval (owner decision
 * of 18 Nov 2026): after the same plan and certificate check, the answer is the proposal
 * (`request`; the `note`, or the reason note when none is given) and nothing is written. The
 * approval runs {@link archiveSpec} again (catalogue-appliers.ts).
 */
export class CategoryArchive extends UseCase<
  CategoryArchiveInput,
  ProposedOr<RestructureOutput>,
  CategoryRestructureFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-archive',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('CategoryArchive');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryRestructureRouteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryArchiveInput,
  ): Promise<Result<ProposedOr<RestructureOutput>, CategoryRestructureFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-archive',
      code: result.ok ? ('category' in result.value ? 'archived' : 'proposed') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryArchiveInput,
  ): Promise<Result<ProposedOr<RestructureOutput>, CategoryRestructureFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const reason = reasonOf(body.value['reason']);
    if (!reason.ok) return reason;
    // Its own read-only unit, before the change's (units do not nest).
    const policy = await catalogueReview(this.deps.review, context);

    return runRestructure(
      this.deps,
      context,
      archiveSpec(this.deps, context, {
        accountId,
        categoryId: id.value,
        treeVersion: treeVersion.value,
        reason: reason.value,
        requestId: null,
      }),
      {
        reviewed: policy.reviewed,
        propose: (target) =>
          proposeCatalogueAction(this.deps.proposer, context, policy, {
            subjectKind: CATEGORY_RESTRUCTURE_SUBJECT_KIND,
            subjectRef: target.id,
            before: categoryStateValues(target),
            after: categoryActionValues({ action: 'archive', reason: reason.value }),
            note: noteOr(body.value['note'], reason.value),
            tooLargePath: 'reason',
          }),
      },
    );
  }
}

/**
 * The archive of `categoryId` as one restructure (shared by the route and by the approval of a
 * proposed archive, which names its request in `requestId`): the plan, the business activities
 * unlinked, the audit row and the `platform-category-archived` event.
 */
export function archiveSpec(
  deps: Pick<CategoryRestructureDependencies, 'audit' | 'outbox' | 'clock' | 'restructure'>,
  context: CallContext,
  archive: {
    readonly accountId: Id<'Account'>;
    readonly categoryId: Id<'Category'>;
    readonly treeVersion: number;
    readonly reason: string;
    readonly requestId: Id<'SystemRequest'> | null;
  },
): RestructureSpec {
  const { market } = context;
  return {
    accountId: archive.accountId,
    targetId: archive.categoryId,
    treeVersion: archive.treeVersion,
    reason: archive.reason,
    kind: 'archive',
    plan: (nodes, target, read) => planArchive(nodes, target, read.archiveProducts),
    finish: async ({ target, plan, tagsMarked, targetVersion }) => {
      const unlinked = await deps.restructure.relinkActivities(
        market,
        target.id,
        null,
        deps.clock.now(),
      );
      await deps.audit.record(
        context,
        PlatformCategoryArchivedAudit.entry(target.id, {
          before: { status: target.status === 'hidden' ? 'hidden' : 'active' },
          after: {
            status: 'archived',
            activitiesUnlinked: unlinked,
            tagsMarked,
            reasonGiven: true,
            requestId: archive.requestId,
          },
        }),
      );
      await deps.outbox.append(context, [
        PlatformCategoryArchived.record({
          aggregateId: target.id,
          aggregateVersion: targetVersion,
          occurredAt: deps.clock.now(),
          payload: { categoryId: target.id, checkedIds: plan.retirementCheckIds },
        }),
      ]);
      return ok(null);
    },
  };
}
