import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import { SamplePayment } from '../../../src/checkout/payment-result.tsx';
import { redirect } from 'next/navigation';
import { loadCheckout, storefrontIsLive } from '../../../src/storefront/source.ts';

export async function generateMetadata() {
  const [t, description] = await Promise.all([
    getTranslations('checkout'),
    seoDescription('payment'),
  ]);
  return pageMetadata({
    name: t('payment'),
    description,
    path: '/checkout/payment',
    noindex: true,
  });
}

/**
 * The local preview's stand-in for Stripe's hosted page (no Stripe call). With the API on, Pay
 * goes to Stripe itself, so this page only sends the buyer back to checkout.
 */
export default async function PaymentRoute() {
  if (storefrontIsLive()) redirect('/checkout');
  const { orderReference } = await loadCheckout();
  return <SamplePayment reference={orderReference} />;
}
