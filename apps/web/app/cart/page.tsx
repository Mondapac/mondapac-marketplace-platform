import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../src/seo/metadata.ts';
import { CartPage } from '../../src/cart/cart-page.tsx';

export async function generateMetadata() {
  const [t, description] = await Promise.all([getTranslations('cart'), seoDescription('cart')]);
  return pageMetadata({ name: t('title'), description, path: '/cart', noindex: true });
}

export default function CartRoute() {
  return <CartPage />;
}
