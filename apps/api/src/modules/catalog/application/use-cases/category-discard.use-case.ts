import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SystemActionProposer, SystemRequestRecorder } from '../../../system-requests';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { canDiscard } from '../../domain/category-edit';
import {
  categoryIdOf,
  closedInput,
  editorAccountOf,
  runStructuralOrPropose,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';
import { discardInUnit } from '../categories/category-write-core';
import { categoryActionValues, categoryStateValues } from '../catalogue-actions';
import {
  CATEGORY_DISCARD_SUBJECT_KIND,
  catalogueReview,
  proposeCatalogueAction,
  type ProposedOr,
} from '../catalogue-review';

export interface CategoryDiscardInput {
  readonly [key: string]: unknown;
}

export interface CategoryDiscardDependencies extends CategoryWriteDependencies {
  /** The review policy of area catalogue (whether the action waits for approval). */
  readonly review: Pick<SystemRequestRecorder, 'areaPolicy'>;
  /** Files the discard for a second admin's approval (Admin Inbox › System requests). */
  readonly proposer: SystemActionProposer;
}

export type CategoryDiscardOutput = ProposedOr<{ readonly category: CategoryWriteView }>;

const KEYS = ['categoryId', 'treeVersion', 'note'] as const;

/**
 * `platform-category.discard` (categories package C3a; plan section 4): an admin sets aside a
 * category that never went live: created by an admin, still hidden, never shown, with no child and
 * no product revision that ever named it. It is archived with a `discarded` revision, never
 * deleted (`category.not-discardable` otherwise). Archiving of a category that sold anything is a
 * restructure (C4). Rule: the key `catalog.category-tree.edit`.
 *
 * Where the Market reviews area catalogue it waits for a second admin's approval (owner decision
 * of 18 Nov 2026): the request needs a `note`, the checks run as for a discard, and the answer is
 * the proposal (`request`), with nothing written. The approval runs `discardInUnit` again
 * (catalogue-appliers.ts).
 */
export class CategoryDiscard extends UseCase<
  CategoryDiscardInput,
  CategoryDiscardOutput,
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-discard',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryDiscard');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryDiscardDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryDiscardInput,
  ): Promise<Result<CategoryDiscardOutput, CategoryWriteFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-discard',
      code: result.ok ? ('category' in result.value ? 'discarded' : 'proposed') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryDiscardInput,
  ): Promise<Result<CategoryDiscardOutput, CategoryWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const { market } = context;
    // Its own read-only unit, before this one (units do not nest).
    const policy = await catalogueReview(this.deps.review, context);

    return runStructuralOrPropose<{ readonly category: CategoryWriteView }>(
      this.deps,
      market,
      treeVersion.value,
      policy.reviewed,
      async (nodes) => {
        const target = nodes.find((node) => node.id === id.value);
        if (target === undefined) return err({ code: 'category.not-found' } as const);
        const facts = await this.deps.store.discardFacts(market, target.id);
        if (!canDiscard(nodes, target, facts)) {
          return err({ code: 'category.not-discardable' } as const);
        }
        return proposeCatalogueAction(this.deps.proposer, context, policy, {
          subjectKind: CATEGORY_DISCARD_SUBJECT_KIND,
          subjectRef: target.id,
          before: categoryStateValues(target),
          after: categoryActionValues({ action: 'discard' }),
          note: body.value['note'],
          tooLargePath: 'categoryId',
        });
      },
      async (nodes, nextTreeVersion) => {
        const done = await discardInUnit(
          this.deps,
          context,
          accountId,
          nodes,
          id.value,
          nextTreeVersion,
          null,
        );
        return done.ok ? ok({ category: done.value.category }) : done;
      },
    );
  }
}
