import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_TREE_VIEW } from '../../contracts/permissions';
import { categoryIdOf, invalid, type ValidationFailure } from '../categories/category-admin-views';
import type { CategoryImageStore } from '../ports/category-image.store';
import { isRenditionSize } from '../ports/product-image.repository';

export interface CategoryImageReadInput {
  readonly categoryId: unknown;
  readonly imageId: unknown;
  readonly size: unknown;
}

export interface CategoryImageReadOutput {
  readonly bytes: Buffer;
  /** Always `image/jpeg`: every rendition is written by the server. */
  readonly contentType: 'image/jpeg';
}

export type CategoryImageReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'image.not-found' }
  | ValidationFailure;

export interface CategoryImageReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly categoryImages: CategoryImageStore;
  readonly objectStore: ObjectStore;
}

/**
 * `platform-category.read-image` (categories package C3c): the bytes of one rendition of a
 * category's current image, for the admin panel; any status. The key is read from the stored
 * rendition row, never built from the request. An unknown category, a category of another Market,
 * an image that is not the category's current one and a missing file all answer one
 * `image.not-found`. Rule: the key `catalog.category-tree.view` and the admin population.
 */
export class CategoryImageRead extends UseCase<
  CategoryImageReadInput,
  CategoryImageReadOutput,
  CategoryImageReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-image-read',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryImageReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryImageReadInput,
  ): Promise<Result<CategoryImageReadOutput, CategoryImageReadFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const id = categoryIdOf(input.categoryId);
    if (!id.ok) return err({ code: 'image.not-found' });
    const image =
      typeof input.imageId === 'string' ? parseId<'CategoryImage'>(input.imageId) : null;
    if (image === null || !image.ok) return err({ code: 'image.not-found' });
    const size = input.size;
    if (typeof size !== 'string' || !isRenditionSize(size)) return invalid('size', 'unknown');
    const { deps } = this;
    let read: Result<Awaited<ReturnType<CategoryImageStore['current']>>, never>;
    try {
      read = await deps.unitOfWork.run(
        market,
        async () => ok(await deps.categoryImages.current(market, id.value)),
        { readOnly: true },
      );
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (!read.ok) return err({ code: 'access.unavailable' });
    const current = read.value;
    const rendition =
      current !== null && current.id === image.value
        ? current.renditions.find((entry) => entry.size === size)
        : undefined;
    if (rendition === undefined) return err({ code: 'image.not-found' });
    try {
      const bytes = await deps.objectStore.get(rendition.objectKey);
      return bytes === null
        ? err({ code: 'image.not-found' })
        : ok({ bytes, contentType: 'image/jpeg' });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
