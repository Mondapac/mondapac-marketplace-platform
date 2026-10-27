import { BackLink, EmptyState, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { OrderDetail } from '../../../../src/orders/order-detail.tsx';
import {
  ORDER_CONFIRM_PICKUP_PERMISSION,
  ORDER_DELIVER_PERMISSION,
  ORDER_READY_PERMISSION,
} from '../../../../src/orders/types.ts';
import { isUuid } from '../../../../src/server/catalog-page.ts';
import { loadOrderDetailPage } from '../../../../src/server/orders-page.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.title') };
}

export default async function OrderPage({
  params,
}: {
  readonly params: Promise<{ sellerOrderId: string }>;
}) {
  const { sellerOrderId } = await params;
  // Ids are UUID v7; any other text is an unknown order, not a failed read.
  if (!isUuid(sellerOrderId) || sellerOrderId[14] !== '7') notFound();
  const t = await getTranslations();
  const title = t('orders.title');
  const page = await loadOrderDetailPage(sellerOrderId);
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
        <EmptyState
          size="page"
          icon="lock"
          title={t('catalog.no-access.title')}
          body={t('catalog.no-access.body')}
          action={<BackLink href="/" label={t('catalog.back-home')} />}
        />
      </SellerShell>
    );
  }
  if (page.kind === 'not-found') {
    return (
      <SellerShell session={page.session} activeId="s_orders" title={title}>
        <EmptyState
          size="page"
          icon="clipboard"
          title={t('orders.not-found.title')}
          body={t('orders.not-found.body')}
          action={<BackLink href="/orders" label={t('orders.back')} />}
        />
      </SellerShell>
    );
  }
  const { permissionKeys, csrfToken } = page.session;
  return (
    <SellerShell session={page.session} activeId="s_orders" title={title}>
      <OrderDetail
        initial={page.order}
        csrfToken={csrfToken}
        canMarkReady={permissionKeys.includes(ORDER_READY_PERMISSION)}
        canDeliver={permissionKeys.includes(ORDER_DELIVER_PERMISSION)}
        canConfirmPickup={permissionKeys.includes(ORDER_CONFIRM_PICKUP_PERMISSION)}
      />
    </SellerShell>
  );
}
