import { getTranslations } from 'next-intl/server';
import { OffersPage } from '../../src/offers/offers-page.tsx';
import { pageMetadata, seoDescription } from '../../src/seo/metadata.ts';
import { loadOffers } from '../../src/storefront/source.ts';

export async function generateMetadata() {
  const t = await getTranslations('offers');
  return pageMetadata({
    name: t('title'),
    description: await seoDescription('offers'),
    path: '/offers',
    // The shelf changes with every special; the page stays out of the index like the listings.
    noindex: true,
  });
}

export default async function OffersRoute() {
  return <OffersPage page={await loadOffers()} />;
}
