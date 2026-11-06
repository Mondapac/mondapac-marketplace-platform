import { Logger } from '@nestjs/common';
import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
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
  type CategoryWriteView,
} from '../categories/category-editor';
import {
  reasonOf,
  runRestructure,
  type CategoryRestructureDependencies,
  type CategoryRestructureFailure,
} from '../categories/category-restructure';

export interface CategoryArchiveInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion', 'reason'] as const;

/**
 * `platform-category.archive` (categories package C4a; catalog design 4.6; plan decision 7): an
 * admin archives a category with no live subcategory. Terminal: there is no restore (use Hide to
 * pause). It leaves the products' paths; its slug resolves to the parent (C6); sellers' business
 * activities stop naming it. Refused while a published product would be left with no live
 * platform category (AC 4: `category.only-platform-category` with the count), on certificate
 * rules (C-4) and above `catalog.maxCategoryChangeTags` tags. Badges are checked again (M1); the
 * own handler of the event calls certification's backstop. Rule: the protected key
 * `catalog.category-tree.restructure`; refused in an acting-as session.
 */
export class CategoryArchive extends UseCase<
  CategoryArchiveInput,
  { readonly category: CategoryWriteView },
  CategoryRestructureFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-archive',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('CategoryArchive');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryRestructureDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryArchiveInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryRestructureFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-archive',
      code: result.ok ? 'archived' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryArchiveInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryRestructureFailure>> {
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
    const { market } = context;

    return runRestructure(this.deps, context, {
      accountId,
      targetId: id.value,
      treeVersion: treeVersion.value,
      reason: reason.value,
      kind: 'archive',
      plan: (nodes, target, read) => planArchive(nodes, target, read.archiveProducts),
      finish: async ({ target, plan, tagsMarked, targetVersion }) => {
        const unlinked = await this.deps.restructure.relinkActivities(
          market,
          target.id,
          null,
          this.deps.clock.now(),
        );
        await this.deps.audit.record(
          context,
          PlatformCategoryArchivedAudit.entry(target.id, {
            before: { status: target.status === 'hidden' ? 'hidden' : 'active' },
            after: {
              status: 'archived',
              activitiesUnlinked: unlinked,
              tagsMarked,
              reasonGiven: true,
            },
          }),
        );
        await this.deps.outbox.append(context, [
          PlatformCategoryArchived.record({
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
