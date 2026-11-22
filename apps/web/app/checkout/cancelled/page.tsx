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
    path: '/checkout/cancelled',
    noindex: true,
  });
}

/** Where Stripe's hosted page returns when the buyer leaves it (the API's cancel URL). */
export default function HostedCancelledRoute() {
  return <PaymentNotCompleted />;
}
