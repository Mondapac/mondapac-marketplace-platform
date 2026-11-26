import { getTranslations } from 'next-intl/server';
import { OffersLoading } from '../../src/offers/offers-page.tsx';

export default async function Loading() {
  const t = await getTranslations('offers');
  return <OffersLoading title={t('title')} label={t('loading')} />;
}
