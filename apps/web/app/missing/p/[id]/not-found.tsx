import { NotFoundView } from '../../../../src/errors/not-found-view.tsx';
import { pageMetadata, seoDescription } from '../../../../src/seo/metadata.ts';
import { productIdOfSegment } from '../../../../src/storefront/links.ts';
import {
  loadStorefrontContent,
  loadUnavailableProduct,
} from '../../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ id: string }>;
}

// The head of this 404 lives here, not in page.tsx: the proxy answers it with status 404, and for
// a 404 response Next reads the head tags from the not-found file of the route, not the page.
// A removed product keeps its own title; both leave the search index.
export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const removed = await loadUnavailableProduct(productIdOfSegment(id));
  return pageMetadata({
    ...(removed ? { name: removed.name } : {}),
    description: removed
      ? await seoDescription('unavailable-product', { name: removed.name })
      : await seoDescription('home'),
    path: `/p/${id}`,
    noindex: true,
  });
}

/** Only shown if the page itself calls `notFound()`, which it does not. */
export default async function MissingProductNotFound() {
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
