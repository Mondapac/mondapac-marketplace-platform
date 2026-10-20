import { NotFoundView } from '../src/errors/not-found-view.tsx';
import { loadStorefrontContent } from '../src/storefront/source.ts';

export default async function NotFound() {
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
