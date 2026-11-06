import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { PlatformCategoryImageChangedAudit } from '../../domain/audit';
import { isEditable } from '../../domain/category-edit';
import {
  categoryImageLogger,
  removeObjects,
  type CategoryImageWriteDependencies,
  type CategoryImageWriteFailure,
  type CategoryImageWriteView,
} from '../categories/category-image';
import {
  announceChanged,
  categoryIdOf,
  closedInput,
  editorAccountOf,
  versionOf,
} from '../categories/category-editor';

/** The answer of the unit and the files it took out of use. */
interface Written {
  readonly view: CategoryImageWriteView;
  readonly oldKeys: readonly string[];
}

export interface CategoryImageRemoveInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'version'] as const;

/**
 * `platform-category.remove-image` (categories package C3c): an admin removes the image of an
 * active or hidden category, naming the category version they saw (a later one is
 * `conflict.stale`). One unit clears the pointer, deletes the image row, raises the category
 * version, records `catalog.platform-category.image-changed` and announces
 * `catalog.platform-category-changed.v1`; the files go after the commit. A category with no image
 * answers as it is and writes nothing. A category of another Market is not found. Rule: the key
 * `catalog.category-tree.edit`; refused in an acting-as session.
 */
export class CategoryImageRemove extends UseCase<
  CategoryImageRemoveInput,
  CategoryImageWriteView,
  CategoryImageWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-image-remove',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryImageWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryImageRemoveInput,
  ): Promise<Result<CategoryImageWriteView, CategoryImageWriteFailure>> {
    const result = await this.#remove(context, input);
    categoryImageLogger.log({
      msg: 'catalog.category-image-remove',
      code: result.ok ? 'removed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #remove(
    context: CallContext,
    input: CategoryImageRemoveInput,
  ): Promise<Result<CategoryImageWriteView, CategoryImageWriteFailure>> {
    if (editorAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const { market } = context;
    const { deps } = this;
    let outcome: Result<Written, CategoryImageWriteFailure>;
    try {
      outcome = await deps.unitOfWork.run<Written, CategoryImageWriteFailure>(market, async () => {
        const owner = await deps.categoryImages.owner(market, id.value);
        if (owner === null) return err({ code: 'category.not-found' } as const);
        if (!isEditable(owner.status)) return err({ code: 'category.not-editable' } as const);
        if (owner.version !== version.value) return err({ code: 'conflict.stale' } as const);
        const treeVersion = (await deps.categories.treeVersion(market)).version;
        const category = {
          id: owner.id,
          slug: owner.slug,
          status: owner.status,
          revisionNo: owner.revisionNo,
          treeVersion,
        };
        if (owner.imageId === null) {
          return ok({
            view: { category: { ...category, version: owner.version }, image: null },
            oldKeys: [],
          });
        }
        const written = await deps.categoryImages.replace(market, owner, null);
        await deps.audit.record(
          context,
          PlatformCategoryImageChangedAudit.entry(owner.id, {
            before: { imageId: owner.imageId },
            after: { imageId: null },
          }),
        );
        await announceChanged(deps, context, owner.id, written.version);
        return ok({
          view: { category: { ...category, version: written.version }, image: null },
          oldKeys: written.removed?.objectKeys ?? [],
        });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
    if (!outcome.ok) return outcome;
    // The files go after the commit; a failed delete leaves an unreachable file only.
    await removeObjects(deps.objectStore, outcome.value.oldKeys);
    return ok(outcome.value.view);
  }
}
