import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isRenditionSize } from '../ports/product-image.repository';
import type { PublishedImagesReader } from '../ports/published-images.reader';

export interface PublishedImageReadInput {
  readonly productId: string;
  readonly imageId: string;
  readonly size: string;
}

export interface PublishedImageReadOutput {
  readonly bytes: Buffer;
  /** Always `image/jpeg`: every rendition is written by the server. */
  readonly contentType: 'image/jpeg';
}

export type PublishedImageReadFailure =
  { readonly code: 'image.not-found' } | { readonly code: 'image.unavailable' };

export interface PublishedImageReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly publishedImagesReader: PublishedImagesReader;
  readonly objectStore: ObjectStore;
}

const NOT_FOUND = { code: 'image.not-found' } as const;

/**
 * `catalog.published-image-read`: the bytes of one rendition of a product photo, for any visitor
 * (the buyer site). Rule `anonymous`: no session, the request's Market. The photo is served only
 * when its product is `published` in the Market, the photo is in that product's current published
 * revision and it is not taken down. A malformed id, an unknown size, an unknown id, another
 * Market's photo, a draft or pending-only photo and a taken-down photo are all `image.not-found`,
 * byte-identical. The object key is read from the stored rendition row, never built from the
 * request. A store or database failure is `image.unavailable`, never a partial answer.
 */
export class PublishedImageRead extends UseCase<
  PublishedImageReadInput,
  PublishedImageReadOutput,
  PublishedImageReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.published-image-read',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishedImageReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PublishedImageReadInput,
  ): Promise<Result<PublishedImageReadOutput, PublishedImageReadFailure>> {
    if (typeof input !== 'object' || input === null) return err(NOT_FOUND);
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    const image = typeof input.imageId === 'string' ? parseId<'ProductImage'>(input.imageId) : null;
    if (product === null || !product.ok || image === null || !image.ok) return err(NOT_FOUND);
    if (typeof input.size !== 'string' || !isRenditionSize(input.size)) return err(NOT_FOUND);
    const size = input.size;
    const { market } = context;
    const read = await this.deps.unitOfWork.run<string | null, never>(
      market,
      async () =>
        ok(
          await this.deps.publishedImagesReader.renditionKey(
            market,
            product.value,
            image.value,
            size,
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'image.unavailable' });
    if (read.value === null) return err(NOT_FOUND);
    try {
      const bytes = await this.deps.objectStore.get(read.value);
      return bytes === null ? err(NOT_FOUND) : ok({ bytes, contentType: 'image/jpeg' });
    } catch {
      return err({ code: 'image.unavailable' });
    }
  }
}
