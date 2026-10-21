import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../src/seo/metadata.ts';
import { CheckoutPage } from '../../src/checkout/checkout-page.tsx';
import { loadCheckout } from '../../src/storefront/source.ts';

export async function generateMetadata() {
  const [t, description] = await Promise.all([
    getTranslations('checkout'),
    seoDescription('checkout'),
  ]);
  return pageMetadata({ name: t('title'), description, path: '/checkout', noindex: true });
}

export default async function CheckoutRoute() {
  return <CheckoutPage source={await loadCheckout()} />;
}
