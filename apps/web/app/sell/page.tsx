import { getTranslations } from 'next-intl/server';
import { SellPage } from '../../src/sell/sell-page.tsx';
import { loadSellerSignUp } from '../../src/storefront/source.ts';

export async function generateMetadata() {
  const [t, ts] = await Promise.all([getTranslations('store'), getTranslations('sell')]);
  return { title: `${ts('title')} | ${t('title')}` };
}

export default async function SellRoute() {
  return <SellPage setup={await loadSellerSignUp()} />;
}
