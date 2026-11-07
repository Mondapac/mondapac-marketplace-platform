import { NotFoundView } from '../../../../src/errors/not-found-view.tsx';
import { loadStorefrontContent } from '../../../../src/storefront/source.ts';

// The 404 of /s/<slug> with no store, rendered on the server; see ../../p/[id]/page.tsx.

export default async function MissingStore() {
  const content = await loadStorefrontContent();
  return <NotFoundView categories={content.categories} />;
}
