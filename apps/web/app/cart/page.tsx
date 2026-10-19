import { getTranslations } from 'next-intl/server';
import { CartPage } from '../../src/cart/cart-page.tsx';

export async function generateMetadata() {
  const [t, store] = await Promise.all([getTranslations('cart'), getTranslations('store')]);
  return { title: `${t('title')} | ${store('title')}`, robots: { index: false } };
}

export default function CartRoute() {
  return <CartPage />;
}
