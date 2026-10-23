import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import { PaymentNotCompleted } from '../../../src/checkout/payment-result.tsx';

export async function generateMetadata() {
  const [t, description] = await Promise.all([
    getTranslations('checkout'),
    seoDescription('not-completed'),
  ]);
  return pageMetadata({
    name: t('try-again'),
    description,
    path: '/checkout/not-completed',
    noindex: true,
  });
}

/** Where Stripe's cancel URL returns: nothing was charged and the cart is kept. */
export default function NotCompletedRoute() {
  return <PaymentNotCompleted />;
}
