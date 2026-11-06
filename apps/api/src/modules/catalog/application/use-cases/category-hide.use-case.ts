import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { PlatformCategoryHiddenAudit } from '../../domain/audit';
import { planHide } from '../../domain/category-edit';
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

export interface CategoryHideInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion'] as const;

/**
 * `platform-category.hide` (categories package C3a; plan decision 6): an admin hides an active
 * category. It and every active descendant go out of the menu and off the category page; the
 * products stay on sale. Each descendant remembers the category whose Hide hid it, so Show
 * restores exactly those and a child that was hidden on its own stays hidden. Every node gets a
 * `hidden` revision and an event. At most 500 categories in one Hide. Rule: the key
 * `catalog.category-tree.edit`.
 */
export class CategoryHide extends UseCase<
  CategoryHideInput,
  { readonly category: CategoryWriteView },
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-hide',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryHide');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryHideInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-hide',
      code: result.ok ? 'hidden' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryHideInput,
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
      const plan = planHide(nodes, target);
      if (!plan.ok) return plan;
      const at = clock.now();
      let version = target.version;
      for (const change of plan.value) {
        const node = nodes.find((entry) => entry.id === change.id)!;
        const newVersion = await store.apply(market, {
          category: node,
          revisionId: ids.next<'CategoryRevision'>(),
          kind: 'hidden',
          texts: node.texts,
          patch: { status: change.status, hiddenById: change.hiddenById },
          authorAccountId: accountId,
          now: at,
        });
        if (node.id === target.id) version = newVersion;
        await announceChanged(this.deps, context, node.id, newVersion);
      }
      await this.deps.audit.record(
        context,
        PlatformCategoryHiddenAudit.entry(target.id, {
          before: { status: 'active' },
          after: { status: 'hidden', cascaded: plan.value.length - 1 },
        }),
      );
      return ok({
        category: {
          id: target.id,
          slug: target.slug,
          status: 'hidden',
          version,
          revisionNo: target.revisionNo + 1,
          treeVersion: nextTreeVersion,
        },
      });
    });
  }
}
