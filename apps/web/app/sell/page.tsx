import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../src/seo/metadata.ts';
import { SellPage } from '../../src/sell/sell-page.tsx';
import { loadSellerSignUp } from '../../src/storefront/source.ts';

export async function generateMetadata() {
  const [t, description] = await Promise.all([getTranslations('sell'), seoDescription('sell')]);
  return pageMetadata({ name: t('title'), description, path: '/sell' });
}

export default async function SellRoute() {
  return <SellPage setup={await loadSellerSignUp()} />;
}
