import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import { isStoreImageSize } from '../../domain/store-image';
import { storedShopSlug } from '../../domain/shop-slug';
import {
  eligibleOnly,
  failClosed,
  publishedStoresLogger,
  readApproved,
  type PublishedStoresDependencies,
  type PublishedStoresUnavailable,
} from '../published/read-published-stores';
import type { StoreImageBytes } from './store-image-read-own.use-case';

export interface PublishedStoreImageReadInput {
  readonly slug: string;
  readonly imageId: string;
  readonly size: string;
}

export type PublishedStoreImageReadFailure =
  { readonly code: 'image.not-found' } | PublishedStoresUnavailable;

export interface PublishedStoreImageReadDependencies extends PublishedStoresDependencies {
  readonly objectStore: ObjectStore;
}

/**
 * `sellers.published-store-image-read` (slice 12 part 2): one rendition of a store's logo or
 * banner for the buyer site. Rule `anonymous`. Answers only the CURRENT logo or banner of a store
 * that has an approved revision, holds the slug and may sell now (the eligibility of the store
 * page); a malformed slug, id or size, an unknown or retired slug, a store that may not sell, an
 * image that was replaced or removed and another store's image all answer one identical
 * `image.not-found`. The bytes are JPEG written by this server. Clear data: no key is unwrapped.
 */
export class PublishedStoreImageRead extends UseCase<
  PublishedStoreImageReadInput,
  StoreImageBytes,
  PublishedStoreImageReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.published-store-image-read',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishedStoreImageReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PublishedStoreImageReadInput,
  ): Promise<Result<StoreImageBytes, PublishedStoreImageReadFailure>> {
    const notFound = err({ code: 'image.not-found' } as const);
    const slug = storedShopSlug(input.slug);
    const imageId = parseId<'StoreImage'>(input.imageId);
    if (slug === null || !imageId.ok || !isStoreImageSize(input.size)) return notFound;
    const { size } = input;
    const read = await failClosed(context, 'published-store-image-read', async () => {
      const store = await readApproved(this.deps, context, (repository) =>
        repository.approvedStoreBySlug(context.market, slug),
      );
      if (store === null) return null;
      const [eligible] = await eligibleOnly(this.deps, context, [store]);
      if (eligible === undefined) return null;
      const image = await this.deps.publishedContent.imageOf(
        context,
        eligible.sellerId,
        imageId.value,
      );
      const rendition = image?.renditions.find((candidate) => candidate.size === size);
      if (rendition === undefined) return null;
      const bytes = await this.deps.objectStore.get(rendition.objectKey);
      if (bytes === null) {
        publishedStoresLogger.error({
          msg: 'sellers.published-store-image-read.object-missing',
          sellerId: eligible.sellerId,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
        });
        return null;
      }
      return bytes;
    });
    if (!read.ok) return read;
    return read.value === null ? notFound : ok({ bytes: read.value, contentType: 'image/jpeg' });
  }
}
