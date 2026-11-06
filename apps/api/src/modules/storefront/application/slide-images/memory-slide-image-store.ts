import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  NewSlideImage,
  SlideImageStore,
  StoredSlideRendition,
} from '../ports/slide-image.store';
import type { SlideImageSize } from './slide-image';

/** An in-memory slide image library for specs, kept per Market like the real tables. */
export class MemorySlideImageStore implements SlideImageStore {
  readonly images = new Map<string, NewSlideImage>();

  private key(market: MarketContext, id: string): string {
    return `${market.marketId}:${id}`;
  }

  insert(market: MarketContext, image: NewSlideImage): Promise<void> {
    this.images.set(this.key(market, image.id), image);
    return Promise.resolve();
  }

  existing(
    market: MarketContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly hasMobile: boolean }>> {
    const found = new Map<string, { readonly hasMobile: boolean }>();
    for (const id of ids) {
      const image = this.images.get(this.key(market, id));
      if (image !== undefined) found.set(id, { hasMobile: image.hasMobile });
    }
    return Promise.resolve(found);
  }

  rendition(
    market: MarketContext,
    imageId: Id<'SlideImage'>,
    size: SlideImageSize,
  ): Promise<StoredSlideRendition | null> {
    const image = this.images.get(this.key(market, imageId));
    return Promise.resolve(image?.renditions.find((r) => r.size === size) ?? null);
  }
}
