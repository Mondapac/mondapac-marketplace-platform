import { getTranslations } from 'next-intl/server';
import { ProductLoading } from '../../src/product/product-page.tsx';

export default async function Loading() {
  const t = await getTranslations('product');
  return <ProductLoading label={t('loading')} />;
}
