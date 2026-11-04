import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { BrandPage } from '../../../src/brands/brand-page.tsx';
import { JsonLd } from '../../../src/seo/json-ld.tsx';
import {
  canonicalOf,
  pageMetadata,
  requestOrigin,
  seoDescription,
} from '../../../src/seo/metadata.ts';
import { brandPageStructuredData } from '../../../src/seo/structured-data.ts';
import { brandAllOf, brandPageNumber } from '../../../src/storefront/brands.ts';
import { loadBrand } from '../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ slug: string }>;
  /** `all=1` opens the full list; `page` pages it. */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const brandPath = (slug: string) => `/brands/${encodeURIComponent(slug)}`;

/** The brand of the path; an unknown, draft or archived one is a 404. */
async function resolve({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const all = brandAllOf(query['all']);
  const page = await loadBrand(slug, all ? brandPageNumber(query['page']) : 1, all);
  if (!page) notFound();
  return { page, slug } as const;
}

export async function generateMetadata(props: Props) {
  const { page, slug } = await resolve(props);
  const { brand, all } = page;
  return pageMetadata({
    name: brand.name,
    description: await seoDescription('brand', { name: brand.name, about: brand.summary ?? '' }),
    // The full list and its pages are copies of the brand page: they point at it and stay out of
    // the index, as does a brand with nothing live to show.
    path: brandPath(slug),
    noindex: all || brand.productCount === 0,
    ...(brand.logo === undefined ? {} : { image: brand.logo.src }),
  });
}

export default async function BrandRoute(props: Props) {
  const [{ page, slug }, origin, t, tb] = await Promise.all([
    resolve(props),
    requestOrigin(),
    getTranslations('catalog'),
    getTranslations('brands'),
  ]);
  const canonical =
    origin === undefined ? undefined : canonicalOf({ path: brandPath(slug) }, origin);
  const data =
    origin === undefined || canonical === undefined || page.all
      ? null
      : brandPageStructuredData(
          page.brand,
          // The visible crumbs: Home, Brands, the brand.
          [
            { name: t('home'), path: '/' },
            { name: tb('title'), path: '/brands' },
            { name: page.brand.name },
          ],
          origin,
          canonical,
        );
  return (
    <>
      <JsonLd data={data} />
      <BrandPage page={page} />
    </>
  );
}
