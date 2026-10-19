import { getTranslations } from 'next-intl/server';
import { SellerLoading } from '../../src/seller/seller-page.tsx';

export default async function Loading() {
  const t = await getTranslations('seller');
  return <SellerLoading label={t('loading')} />;
}
