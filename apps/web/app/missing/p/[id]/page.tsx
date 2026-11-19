import { NotFoundView } from '../../../../src/errors/not-found-view.tsx';
import { UnavailableProductView } from '../../../../src/errors/unavailable-product.tsx';
import { productIdOfSegment } from '../../../../src/storefront/links.ts';
import {
  loadStorefrontContent,
  loadUnavailableProduct,
} from '../../../../src/storefront/source.ts';

// The 404 of /p/<segment>, rendered on the server. The proxy rewrites a product path with no page
// here and sets the status to 404 itself (proxy.ts); a page cannot. A client's own request for
// /missing/... never reaches this page: the proxy answers it with the framework 404.

interface Props {
  readonly params: Promise<{ id: string }>;
}

export default async function MissingProduct({ params }: Props) {
  const { id } = await params;
  const removed = await loadUnavailableProduct(productIdOfSegment(id));
  if (removed) return <UnavailableProductView product={removed} />;
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
