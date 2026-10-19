import { getTranslations } from 'next-intl/server';
import { SamplePayment } from '../../../src/checkout/payment-result.tsx';
import { loadCheckout } from '../../../src/storefront/source.ts';

export async function generateMetadata() {
  const [t, store] = await Promise.all([getTranslations('checkout'), getTranslations('store')]);
  return { title: `${t('payment')} | ${store('title')}`, robots: { index: false } };
}

/** Stands in for the redirect to Stripe's hosted page until payment is wired (no Stripe call). */
export default async function PaymentRoute() {
  const { orderReference } = await loadCheckout();
  return <SamplePayment reference={orderReference} />;
}
