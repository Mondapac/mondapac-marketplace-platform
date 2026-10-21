import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import { Confirmation } from '../../../src/checkout/payment-result.tsx';

export async function generateMetadata() {
  const [t, description] = await Promise.all([
    getTranslations('checkout'),
    seoDescription('confirmation'),
  ]);
  return pageMetadata({
    name: t('title'),
    description,
    path: '/checkout/confirmation',
    noindex: true,
  });
}

/** Where Stripe's success URL returns. */
export default function ConfirmationRoute() {
  return <Confirmation />;
}
