import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { DeliverySettings } from '../../../src/delivery/delivery-settings.tsx';
import { loadDeliveryPage } from '../../../src/server/delivery-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('delivery.title') };
}

export default async function DeliveryPage() {
  const t = await getTranslations();
  const page = await loadDeliveryPage();
  if (page.kind === 'unavailable') {
    return <LoadError message={t('delivery.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (page.kind === 'no-access') {
    return (
      <SellerShell session={page.session} activeId="s_delivery" title={t('delivery.title')}>
        <h1 className="mb-6 text-2xl font-semibold">{t('delivery.title')}</h1>
        <h2 className="mb-2 text-lg font-semibold">{t('catalog.no-access.title')}</h2>
        <p className="text-fg-muted">{t('catalog.no-access.body')}</p>
      </SellerShell>
    );
  }
  return (
    <SellerShell session={page.session} activeId="s_delivery" title={t('delivery.title')}>
      <h1 className="mb-6 text-2xl font-semibold">{t('delivery.title')}</h1>
      <DeliverySettings initial={page.view} csrfToken={page.session.csrfToken} canEdit />
    </SellerShell>
  );
}
