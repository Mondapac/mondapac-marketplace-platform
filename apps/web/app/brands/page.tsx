import { getTranslations } from 'next-intl/server';
import { BrandsPage } from '../../src/brands/brands-page.tsx';
import { JsonLd } from '../../src/seo/json-ld.tsx';
import {
  canonicalOf,
  pageMetadata,
  requestOrigin,
  seoDescription,
} from '../../src/seo/metadata.ts';
import { breadcrumbStructuredData } from '../../src/seo/structured-data.ts';
import { loadBrands } from '../../src/storefront/source.ts';

const PATH = '/brands';

export async function generateMetadata() {
  const [t, description, index] = await Promise.all([
    getTranslations('brands'),
    seoDescription('brands'),
    loadBrands(),
  ]);
  // A page with no brand to list stays out of the index.
  return pageMetadata({
    name: t('title'),
    description,
    path: PATH,
    noindex: index.sections.length === 0,
  });
}

export default async function BrandsRoute() {
  const [index, origin, t, tc] = await Promise.all([
    loadBrands(),
    requestOrigin(),
    getTranslations('brands'),
    getTranslations('catalog'),
  ]);
  const canonical = origin === undefined ? undefined : canonicalOf({ path: PATH }, origin);
  const data =
    origin === undefined || canonical === undefined || index.sections.length === 0
      ? null
      : breadcrumbStructuredData([{ name: tc('home'), path: '/' }, { name: t('title') }], origin);
  return (
    <>
      <JsonLd data={data} />
      <BrandsPage index={index} />
    </>
  );
}
