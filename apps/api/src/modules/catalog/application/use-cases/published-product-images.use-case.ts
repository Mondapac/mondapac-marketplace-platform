import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_FACADE_BATCH,
  MAX_PUBLISHED_IMAGES,
  type CatalogBatchTooLarge,
  type CatalogValidationFailed,
  type PublishedImageRef,
} from '../../contracts/catalog.facade';
import type { PublishedImagesReader } from '../ports/published-images.reader';

export interface PublishedProductImagesInput {
  readonly productIds: readonly string[];
}

export interface PublishedProductImagesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly publishedImagesReader: PublishedImagesReader;
}

type Failure = CatalogValidationFailed | CatalogBatchTooLarge;

/**
 * `publishedProductImages`: the public photos of each requested product, for the buyer site's
 * cards and product page. Rule `anonymous`: only ids and pixel sizes of photos in a published
 * product's published revision that are not taken down. At most 200 products, refused whole above;
 * a malformed id is `validation.failed`. One read-only unit (ADR-0025). The Market is the
 * context's: an unknown id and another Market's id are absent, byte-identical.
 */
export class PublishedProductImagesQuery extends UseCase<
  PublishedProductImagesInput,
  ReadonlyMap<Id<'Product'>, readonly PublishedImageRef[]>,
  Failure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.published-product-images',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishedProductImagesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PublishedProductImagesInput,
  ): Promise<Result<ReadonlyMap<Id<'Product'>, readonly PublishedImageRef[]>, Failure>> {
    if (!Array.isArray(input.productIds)) {
      return err({ code: 'validation.failed', fields: [{ path: 'productIds', code: 'type' }] });
    }
    if (input.productIds.length > MAX_FACADE_BATCH) return err({ code: 'batch.too-large' });
    const ids = new Set<Id<'Product'>>();
    for (const value of input.productIds as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'Product'>(value) : null;
      if (parsed === null || !parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'productIds', code: 'format' }] });
      }
      ids.add(parsed.value);
    }
    if (ids.size === 0) return ok(new Map());
    const requested = [...ids];
    return this.deps.unitOfWork.run<
      ReadonlyMap<Id<'Product'>, readonly PublishedImageRef[]>,
      Failure
    >(
      context.market,
      async () =>
        ok(
          await this.deps.publishedImagesReader.imagesOf(
            context.market,
            requested,
            MAX_PUBLISHED_IMAGES,
          ),
        ),
      { readOnly: true },
    );
  }
}
