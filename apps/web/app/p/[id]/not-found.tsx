import { NotFoundView } from '../../../src/errors/not-found-view.tsx';
import { loadStorefrontContent } from '../../../src/storefront/source.ts';

/**
 * The fallback 404 of a product path, for a product that went between the proxy's read and the
 * page's. The proxy answers a missing product itself, with a server-rendered body and the removed
 * product's own page (`app/missing/p/[id]`). Next adds noindex to every not-found page.
 */
export default async function ProductNotFound() {
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
