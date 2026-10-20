import { NotFoundView } from '../../../src/errors/not-found-view.tsx';
import { loadStorefrontContent } from '../../../src/storefront/source.ts';

/** An unknown product id: the shop-wide 404 page. A removed product has its own page. */
export default async function ProductNotFound() {
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
