import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import { SamplePayment } from '../../../src/checkout/payment-result.tsx';
import { loadCheckout } from '../../../src/storefront/source.ts';

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

/** Stands in for the redirect to Stripe's hosted page until payment is wired (no Stripe call). */
export default async function PaymentRoute() {
  const { orderReference } = await loadCheckout();
  return <SamplePayment reference={orderReference} />;
}
