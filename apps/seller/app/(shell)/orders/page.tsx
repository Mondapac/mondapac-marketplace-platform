import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { loadOrdersPage } from '../../../src/server/orders-page.ts';
import { SellerOrders } from '../../../src/orders/seller-orders.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.title') };
}

export default async function OrdersPage() {
  const t = await getTranslations();
  const title = t('orders.title');
  const page = await loadOrdersPage();
  if (page.kind === 'unavailable') {
    return (
      <LoadError
        title={title}
        message={t('orders.error.unavailable')}
        retryLabel={t('load.retry')}
      />
    );
  }
  if (page.kind === 'no-access') {
    return (
      <SellerShell session={page.session} activeId="s_orders" title={title}>
        <h1 className="mb-2 text-2xl font-semibold">{t('catalog.no-access.title')}</h1>
        <p className="text-fg-muted">{t('catalog.no-access.body')}</p>
      </SellerShell>
    );
  }
  return (
    <SellerShell session={page.session} activeId="s_orders" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <SellerOrders initial={page.page} />
    </SellerShell>
  );
}
