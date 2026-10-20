import { HomeSections } from '../src/home/home-sections.tsx';
import { loadHomeContent } from '../src/storefront/source.ts';

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
