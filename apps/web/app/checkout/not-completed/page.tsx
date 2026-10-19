import { getTranslations } from 'next-intl/server';
import { PaymentNotCompleted } from '../../../src/checkout/payment-result.tsx';

export async function generateMetadata() {
  const [t, store] = await Promise.all([getTranslations('checkout'), getTranslations('store')]);
  return { title: `${t('try-again')} | ${store('title')}`, robots: { index: false } };
}

/** Where Stripe's cancel URL returns: nothing was charged and the cart is kept. */
export default function NotCompletedRoute() {
  return <PaymentNotCompleted />;
}
