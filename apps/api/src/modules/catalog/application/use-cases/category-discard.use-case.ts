import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { PlatformCategoryDiscardedAudit } from '../../domain/audit';
import { canDiscard } from '../../domain/category-edit';
import {
  announceChanged,
  categoryIdOf,
  closedInput,
  editorAccountOf,
  runStructural,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';

export interface CategoryDiscardInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion'] as const;

/**
 * `platform-category.discard` (categories package C3a; plan section 4): an admin sets aside a
 * category that never went live: created by an admin, still hidden, never shown, with no child
 * and no product revision that ever named it. It is archived with a `discarded` revision, never
 * deleted (`category.not-discardable` otherwise). Archiving of a category that sold anything is
 * a restructure (C4). Rule: the key `catalog.category-tree.edit`.
 */
export class CategoryDiscard extends UseCase<
  CategoryDiscardInput,
  { readonly category: CategoryWriteView },
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-discard',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryDiscard');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryDiscardInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-discard',
      code: result.ok ? 'discarded' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryDiscardInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const { market } = context;
    const { store, ids, clock } = this.deps;

    return runStructural(this.deps, market, treeVersion.value, async (nodes, nextTreeVersion) => {
      const target = nodes.find((node) => node.id === id.value);
      if (target === undefined) return err({ code: 'category.not-found' } as const);
      const facts = await store.discardFacts(market, target.id);
      if (!canDiscard(nodes, target, facts)) {
        return err({ code: 'category.not-discardable' } as const);
      }
      const version = await store.apply(market, {
        category: target,
        revisionId: ids.next<'CategoryRevision'>(),
        kind: 'discarded',
        texts: target.texts,
        patch: { status: 'archived', hiddenById: null },
        authorAccountId: accountId,
        now: clock.now(),
      });
      await this.deps.audit.record(
        context,
        PlatformCategoryDiscardedAudit.entry(target.id, {
          before: { status: 'hidden' },
          after: { status: 'archived' },
        }),
      );
      await announceChanged(this.deps, context, target.id, version);
      return ok({
        category: {
          id: target.id,
          slug: target.slug,
          status: 'archived',
          version,
          revisionNo: target.revisionNo + 1,
          treeVersion: nextTreeVersion,
        },
      });
    });
  }
}
