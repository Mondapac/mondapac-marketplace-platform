import { getTranslations } from 'next-intl/server';
import { BrandsLoading } from '../../src/brands/brands-page.tsx';

export default async function Loading() {
  const t = await getTranslations('brands');
  return <BrandsLoading title={t('title')} label={t('loading')} />;
}
