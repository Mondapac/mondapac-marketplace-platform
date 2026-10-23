import type { CallContext, Id } from '@mondapac/shared-kernel';
import { MAX_IMAGES_PER_PRODUCT, type ImageRef } from '../domain/image-ref';
import type { ProductImages, PublicImage } from './ports/product-images';

const refOf = ({ imageId, width, height }: PublicImage, alt: string): ImageRef => ({
  imageId,
  width,
  height,
  alt,
});

/**
 * The public photos of these products as answer refs, in the published revision's order, at most
 * 8 each, `alt` being the name given with the product. A product with no photo is absent; a photo
 * source that cannot answer gives an empty map (the page shows its placeholder, never an error).
 */
export async function imageRefsOf(
  images: ProductImages,
  context: CallContext,
  products: readonly { readonly productId: Id<'Product'>; readonly name: string }[],
): Promise<ReadonlyMap<Id<'Product'>, readonly ImageRef[]>> {
  const refs = new Map<Id<'Product'>, readonly ImageRef[]>();
  if (products.length === 0) return refs;
  const found = await images.of(context, [...new Set(products.map((p) => p.productId))]);
  if (found === null) return refs;
  for (const { productId, name } of products) {
    const list = found.get(productId);
    if (list === undefined || list.length === 0) continue;
    refs.set(
      productId,
      list.slice(0, MAX_IMAGES_PER_PRODUCT).map((image) => refOf(image, name)),
    );
  }
  return refs;
}

/** Adds `primaryImage` (the first photo, `alt` from the item's own name, or null) to each item. */
export async function withPrimaryImages<
  T extends { readonly productId: Id<'Product'>; readonly name: string },
>(
  images: ProductImages,
  context: CallContext,
  items: readonly T[],
): Promise<(T & { readonly primaryImage: ImageRef | null })[]> {
  if (items.length === 0) return [];
  const found = await images.of(context, [...new Set(items.map((item) => item.productId))]);
  return items.map((item) => {
    const first = found?.get(item.productId)?.[0];
    return { ...item, primaryImage: first === undefined ? null : refOf(first, item.name) };
  });
}
