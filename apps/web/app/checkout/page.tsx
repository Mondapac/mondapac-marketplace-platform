import { getTranslations } from 'next-intl/server';
import { CheckoutPage } from '../../src/checkout/checkout-page.tsx';
import { loadCheckout } from '../../src/storefront/source.ts';

export async function generateMetadata() {
  const [t, store] = await Promise.all([getTranslations('checkout'), getTranslations('store')]);
  return { title: `${t('title')} | ${store('title')}`, robots: { index: false } };
}

export default async function CheckoutRoute() {
  return <CheckoutPage source={await loadCheckout()} />;
}
