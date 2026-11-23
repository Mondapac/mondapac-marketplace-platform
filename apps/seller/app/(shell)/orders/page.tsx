import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { loadOrdersPage } from '../../../src/server/orders-page.ts';
import { SellerOrders } from '../../../src/orders/seller-orders.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.title') };
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { view } = await searchParams;
  const t = await getTranslations();
  const title = t('orders.title');
  const page = await loadOrdersPage();
  if (page.kind === 'unavailable') {
    return (
      <div className="p-6">
        <PageHeader title={title} className="mb-4" />
        <LoadError
          message={t('orders.error.unavailable')}
          retryLabel={t('load.retry')}
          className="w-full"
        />
      </div>
    );
  }
  if (page.kind === 'no-access') {
    return (
      <SellerShell session={page.session} activeId="s_orders" title={title}>
        <PageHeader title={t('catalog.no-access.title')} className="mb-2" />
        <p className="text-fg-muted">{t('catalog.no-access.body')}</p>
      </SellerShell>
    );
  }
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return (
    <SellerShell session={page.session} activeId="s_orders" title={title}>
      <PageHeader title={title} className="mb-4" />
      <SellerOrders
        initial={page.page}
        paging={page.paging}
        accountId={page.session.accountId}
        marketId={marketId}
        csrfToken={page.session.csrfToken}
        initialView={view === 'board' ? 'board' : 'table'}
      />
    </SellerShell>
  );
}
