import { getTranslations } from 'next-intl/server';
import { HomeSections } from '../src/home/home-sections.tsx';
import { JsonLd } from '../src/seo/json-ld.tsx';
import { pageMetadata, requestOrigin, seoDescription } from '../src/seo/metadata.ts';
import { homeStructuredData } from '../src/seo/structured-data.ts';
import { loadHomeContent } from '../src/storefront/source.ts';

export async function generateMetadata() {
  return pageMetadata({ description: await seoDescription('home'), path: '/' });
}

export default async function HomePage() {
  const [content, origin, store] = await Promise.all([
    loadHomeContent(),
    requestOrigin(),
    getTranslations('store'),
  ]);
  return (
    <>
      <JsonLd data={origin === undefined ? null : homeStructuredData(store('title'), origin)} />
      <HomeSections
        sections={content.sections}
        categories={content.categories}
        sellers={content.sellers}
      />
    </>
  );
}
