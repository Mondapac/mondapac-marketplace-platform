import { getTranslations } from 'next-intl/server';
import { SellersLoading } from '../../src/sellers/sellers-page.tsx';

export default async function Loading() {
  const t = await getTranslations('sellers');
  return <SellersLoading label={t('loading')} />;
}
