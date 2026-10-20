import { NotFoundView } from '../../../src/errors/not-found-view.tsx';
import { loadStorefrontContent } from '../../../src/storefront/source.ts';

/** An unknown seller slug: the shop-wide 404 page. A closed store has its own page. */
export default async function SellerNotFound() {
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
