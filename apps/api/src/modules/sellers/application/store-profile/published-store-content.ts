import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { StoreImageRef } from '../../domain/store-image';
import type { StoreImageRepository, StoredStoreImage } from '../ports/store-image.repository';
import type { StoreProfileContentRepository } from '../ports/store-profile-content.repository';
import type { StoreProfileContentSealer } from '../ports/store-profile-content-sealer';
import type { StoreProfileLocalesPolicy } from '../ports/store-profile-locales';
import { PublishedAboutCache } from './published-about-cache';

const logger = new Logger('PublishedStoreContent');

/** What a store page adds to the clear facts: the About text and the two images. */
export interface PublishedStoreProfile {
  /** The Market's default locale text, plain; `null` when the store wrote none. */
  readonly about: string | null;
  readonly logo: StoreImageRef | null;
  readonly banner: StoreImageRef | null;
}

export interface PublishedStoreContentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly storeContent: StoreProfileContentRepository;
  readonly storeImages: StoreImageRepository;
  readonly contentSealer: StoreProfileContentSealer;
  readonly localesPolicy: StoreProfileLocalesPolicy;
  readonly aboutCache: PublishedAboutCache;
}

/**
 * The store profile content of the public store reads (slice 12 part 2). The caller has already
 * established that the store may sell now; this reads only what that store published.
 *
 * The About text is encrypted (sellers design 8.1), so Hassan M5's rule applies: the published
 * pointer is read in clear on every call and the decrypted text is kept by revision id in
 * {@link PublishedAboutCache}. A fault reading or opening the text is logged (ids and codes
 * only) and the page shows no About text: a text problem does not take the store page down, and
 * no text is ever shown that was not opened whole.
 */
export class PublishedStoreContentReader {
  constructor(private readonly deps: PublishedStoreContentDependencies) {}

  /** The About text, logo and banner of one store. */
  async profileOf(context: CallContext, sellerId: Id<'Seller'>): Promise<PublishedStoreProfile> {
    const { market } = context;
    const { unitOfWork, storeContent, storeImages } = this.deps;
    const read = await unitOfWork.run(
      market,
      async () =>
        ok({
          published: await storeContent.published(market, sellerId),
          images: await storeImages.currentOf(market, sellerId),
        }),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('the read unit failed');
    const { published, images } = read.value;
    const ref = (kind: 'logo' | 'banner'): StoreImageRef | null => {
      const found = images.find((image) => image.kind === kind);
      return found === undefined
        ? null
        : { id: found.id, width: found.width, height: found.height };
    };
    const about =
      published === null ? null : await this.#aboutOf(context, sellerId, published.revisionId);
    return { about, logo: ref('logo'), banner: ref('banner') };
  }

  /** The current image of the store with this id, with its renditions, or null (not the current one). */
  async imageOf(
    context: CallContext,
    sellerId: Id<'Seller'>,
    imageId: Id<'StoreImage'>,
  ): Promise<StoredStoreImage | null> {
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.storeImages.findCurrent(market, sellerId, imageId)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('the read unit failed');
    return read.value;
  }

  /** The logo of each store that has one. */
  async logosOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, StoreImageRef>> {
    if (sellerIds.length === 0) return new Map();
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.storeImages.logosOf(market, sellerIds)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('the read unit failed');
    return read.value;
  }

  async #aboutOf(
    context: CallContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'StoreProfileRevision'>,
  ): Promise<string | null> {
    const { market } = context;
    const { aboutCache } = this.deps;
    const key = PublishedAboutCache.keyOf(market, sellerId, revisionId);
    const cached = aboutCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const sealed = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.storeContent.content(market, sellerId, revisionId)),
        { readOnly: true },
      );
      if (!sealed.ok || sealed.value === null) throw new Error('the revision was not found');
      const opened = await this.deps.contentSealer.open(market, sellerId, sealed.value);
      if (!opened.ok) {
        // An erased seller (destroyed key) or content of a shape this reader does not know.
        logger.warn({
          msg: 'sellers.published-store-content.unreadable',
          code: opened.error.code,
          sellerId,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        aboutCache.set(key, null);
        return null;
      }
      const { defaultLocale } = this.deps.localesPolicy.locales(market);
      const text = opened.value.about[defaultLocale] ?? null;
      aboutCache.set(key, text);
      return text;
    } catch (error) {
      logger.error({
        msg: 'sellers.published-store-content.failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return null;
    }
  }
}

/** Nest token of the {@link PublishedStoreContentReader}. */
export const PUBLISHED_STORE_CONTENT = Symbol('PUBLISHED_STORE_CONTENT');
