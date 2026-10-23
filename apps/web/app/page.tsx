import { HomeSections } from '../src/home/home-sections.tsx';
import { pageMetadata, seoDescription } from '../src/seo/metadata.ts';
import { loadHomeContent } from '../src/storefront/source.ts';

export async function generateMetadata() {
  return pageMetadata({ description: await seoDescription('home'), path: '/' });
}

export default async function HomePage() {
  const content = await loadHomeContent();
  return (
    <HomeSections
      sections={content.sections}
      categories={content.categories}
      sellers={content.sellers}
    />
  );
}
