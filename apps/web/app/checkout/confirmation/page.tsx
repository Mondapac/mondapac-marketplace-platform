import { getTranslations } from 'next-intl/server';
import { Confirmation } from '../../../src/checkout/payment-result.tsx';

export async function generateMetadata() {
  const [t, store] = await Promise.all([getTranslations('checkout'), getTranslations('store')]);
  return { title: `${t('title')} | ${store('title')}`, robots: { index: false } };
}

/** Where Stripe's success URL returns. */
export default function ConfirmationRoute() {
  return <Confirmation />;
}
