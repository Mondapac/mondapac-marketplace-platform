import { headers } from 'next/headers';
import { UnavailableProductView } from '../../../src/errors/unavailable-product.tsx';
import { NotFoundView } from '../../../src/errors/not-found-view.tsx';
import { PATH_HEADER } from '../../../src/storefront/path-header.ts';
import { removedProductOfPath } from '../../../src/storefront/product-route.ts';
import { loadStorefrontContent } from '../../../src/storefront/source.ts';

/**
 * The 404 of a product path. A removed product keeps its own body ("no longer available", with
 * similar items) inside the 404 response; an unknown id gets the shop-wide 404 page. Next adds
 * noindex to every not-found page.
 */
export default async function ProductNotFound() {
  const removed = await removedProductOfPath((await headers()).get(PATH_HEADER));
  if (removed) return <UnavailableProductView product={removed} />;
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
