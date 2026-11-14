import { BackLink, EmptyState, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PackingSlip } from '../../../../../src/orders/packing-slip.tsx';
import { isUuid } from '../../../../../src/server/catalog-page.ts';
import { packingSlipAvailable } from '../../../../../src/orders/types.ts';
import { loadOrderDetailPage } from '../../../../../src/server/orders-page.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.slip.title') };
}

/** The printable packing slip: its print stylesheet hides the panel shell, so the printed page is the slip alone. */
export default async function PackingSlipPage({
  params,
}: {
  readonly params: Promise<{ sellerOrderId: string }>;
}) {
  const { sellerOrderId } = await params;
  if (!isUuid(sellerOrderId) || sellerOrderId[14] !== '7') notFound();
  const t = await getTranslations();
  const page = await loadOrderDetailPage(sellerOrderId);
  if (page.kind === 'unavailable') {
    return (
      <div className="p-6">
        <LoadError
          message={t('orders.error.unavailable')}
          retryLabel={t('load.retry')}
          className="w-full"
        />
      </div>
    );
  }
  if (page.kind !== 'ok') {
    return (
      <div className="p-6">
        <EmptyState
          size="page"
          icon={page.kind === 'no-access' ? 'lock' : 'clipboard'}
          title={t(
            page.kind === 'no-access' ? 'catalog.no-access.title' : 'orders.not-found.title',
          )}
          body={t(page.kind === 'no-access' ? 'catalog.no-access.body' : 'orders.not-found.body')}
          action={<BackLink href="/orders" label={t('orders.back')} />}
        />
      </div>
    );
  }
  // Checked here on the server as well, so the address and phone of an order already sent (or
  // refunded in full) never reach the browser, not only stay off the screen.
  if (!packingSlipAvailable(page.order)) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 bg-surface p-6 text-fg">
        <BackLink href={`/orders/${page.order.sellerOrderId}`} label={t('orders.slip.back')} />
        <p className="text-fg-muted">{t('orders.slip.not-available')}</p>
      </main>
    );
  }
  return <PackingSlip order={page.order} />;
}
