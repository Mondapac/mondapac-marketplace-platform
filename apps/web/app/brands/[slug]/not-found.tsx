import { NotFoundView } from '../../../src/errors/not-found-view.tsx';
import { loadStorefrontContent } from '../../../src/storefront/source.ts';

/** An unknown, draft or archived brand: the shop-wide 404 page (it never says why). */
export default async function BrandNotFound() {
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
