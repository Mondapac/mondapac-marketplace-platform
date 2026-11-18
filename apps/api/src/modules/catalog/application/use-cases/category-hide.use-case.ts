import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import {
  categoryIdOf,
  closedInput,
  editorAccountOf,
  runStructural,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';
import { hideInUnit } from '../categories/category-write-core';

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

    return runStructural(this.deps, market, treeVersion.value, async (nodes, nextTreeVersion) => {
      const hidden = await hideInUnit(
        this.deps,
        context,
        accountId,
        nodes,
        id.value,
        nextTreeVersion,
        null,
      );
      return hidden.ok ? ok({ category: hidden.value.category }) : hidden;
    });
  }
}
