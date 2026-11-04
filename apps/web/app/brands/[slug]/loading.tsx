import { getTranslations } from 'next-intl/server';
import { BrandLoading } from '../../../src/brands/brand-page.tsx';

export default async function Loading() {
  const t = await getTranslations('brands');
  return <BrandLoading label={t('loading-brand')} />;
}
