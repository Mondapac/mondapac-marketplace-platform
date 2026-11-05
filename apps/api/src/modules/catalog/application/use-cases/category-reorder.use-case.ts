import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { PlatformCategoryReorderedAudit } from '../../domain/audit';
import { planReorder } from '../../domain/category-edit';
import {
  announceChanged,
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

export interface CategoryReorderInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'direction', 'treeVersion'] as const;

/**
 * `platform-category.reorder` (categories package C3a; Move up and Move down): an admin swaps a
 * category with the sibling above or below it. Only the order among siblings changes, so it is not
 * structural for certification, but it does raise the tree version like every tree write: a page
 * that showed the old order must reload. Each of the two categories gets a `reordered` revision.
 * `category.reorder-edge` when there is no sibling in that direction. Rule: the key
 * `catalog.category-tree.edit`.
 */
export class CategoryReorder extends UseCase<
  CategoryReorderInput,
  { readonly category: CategoryWriteView },
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-reorder',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryReorder');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryReorderInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
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
    const direction = body.value['direction'];
    if (direction !== 'up' && direction !== 'down') return invalid('direction', 'unknown');
    return runStructural(this.deps, market, treeVersion.value, async (nodes, nextTreeVersion) => {
      const target = nodes.find((node) => node.id === id.value);
      if (target === undefined) return err({ code: 'category.not-found' } as const);
      const neighbour = planReorder(nodes, target, direction);
      if (!neighbour.ok) return neighbour;
      const at = clock.now();
      await store.swapPositions(market, target, neighbour.value);
      const version = await store.apply(market, {
        category: target,
        revisionId: ids.next<'CategoryRevision'>(),
        kind: 'reordered',
        texts: target.texts,
        patch: {},
        authorAccountId: accountId,
        now: at,
      });
      const other = await store.apply(market, {
        category: neighbour.value,
        revisionId: ids.next<'CategoryRevision'>(),
        kind: 'reordered',
        texts: neighbour.value.texts,
        patch: {},
        authorAccountId: accountId,
        now: at,
      });
      await this.deps.audit.record(
        context,
        PlatformCategoryReorderedAudit.entry(target.id, {
          before: { position: target.position },
          after: { position: neighbour.value.position },
        }),
      );
      await announceChanged(this.deps, context, target.id, version);
      await announceChanged(this.deps, context, neighbour.value.id, other);
      return ok({
        category: {
          id: target.id,
          slug: target.slug,
          status: target.status,
          version,
          revisionNo: target.revisionNo + 1,
          treeVersion: nextTreeVersion,
        },
      });
    });
  }
}
