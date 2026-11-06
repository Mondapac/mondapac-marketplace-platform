import { notFound, permanentRedirect } from 'next/navigation';
import { resolveCategory } from '../../../../src/storefront/catalog.ts';
import { CATEGORY_SLUG } from '../../../../src/storefront/category-tree.ts';
import { categoryHref } from '../../../../src/storefront/links.ts';

interface Props {
  readonly params: Promise<{ slug: string; sub: string }>;
}

/**
 * The old two-level address `/c/<category>/<sub>` (before categories C6). With the API on, the
 * proxy answers it first with a 301 to `/c/<sub>` (or to where that slug moved); this page is what
 * is left: the sample data, or an API that did not answer. The subcategory is checked first, then
 * the category; a path that names neither is a 404. A deeper path never matches this route.
 */
export default async function OldCategoryPath({ params }: Props) {
  const { slug, sub } = await params;
  for (const candidate of [sub, slug]) {
    if (!CATEGORY_SLUG.test(candidate)) continue;
    if ((await resolveCategory(candidate)) !== undefined)
      permanentRedirect(categoryHref(candidate));
  }
  notFound();
}
