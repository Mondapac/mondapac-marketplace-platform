import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PublishedProduct } from '../../contracts/catalog.facade';

/**
 * The read behind `publishedProduct`: the published revision's texts, categories and published
 * Variants of one product. Only a product whose status is `published` with a published revision
 * is answered; every other id (a draft, an unknown one, another Market's) is `null`. Texts are in
 * the requested locale, else the fallback, else the first locale in code order. Never reads a
 * draft, an image, an attribute or a tag. Runs in a read-only unit.
 */
export interface PublishedProductReader {
  read(
    market: MarketContext,
    productId: Id<'Product'>,
    locales: { readonly requested: string; readonly fallback: string },
  ): Promise<PublishedProduct | null>;
}

export const PUBLISHED_PRODUCT_READER = Symbol('PUBLISHED_PRODUCT_READER');
