import { HomeSections } from '../src/home/home-sections.tsx';
import { loadStorefrontContent } from '../src/storefront/source.ts';

export default async function HomePage() {
  const content = await loadStorefrontContent();
  return (
    <HomeSections
      sections={content.home}
      categories={content.categories}
      sellers={content.sellers}
    />
  );
}
