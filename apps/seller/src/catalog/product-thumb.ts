/**
 * The thumbnail address of a product photo, through the panel's relay. A PLATFORM product's photo
 * is a published one, served by the public image route of the panel's own Market (the relay
 * refuses any other Market); a SELLER product's photo is served by the seller's own image route,
 * which checks that the seller owns it. No photo, or an unknown scope: null (the package tile).
 */
export function productThumbSrc(
  marketId: string,
  product: {
    readonly productId: string;
    readonly scope: 'PLATFORM' | 'SELLER' | null;
    readonly primaryImageId: string | null;
  },
): string | null {
  const { productId, scope, primaryImageId } = product;
  if (primaryImageId === null) return null;
  if (scope === 'PLATFORM') {
    return `/api/catalog/public-images/${encodeURIComponent(marketId)}/${productId}/${primaryImageId}/thumb`;
  }
  if (scope === 'SELLER') {
    return `/api/catalog/seller/products/${productId}/images/${primaryImageId}/thumb`;
  }
  return null;
}
