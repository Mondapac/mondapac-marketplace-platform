import { BackLink, EmptyState, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { PackingSlips } from '../../../../src/orders/packing-slip.tsx';
import { isUuid } from '../../../../src/server/catalog-page.ts';
import { SLIPS_MAX, loadPackingSlips } from '../../../../src/server/orders-page.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.slip.many-title') };
}

/**
 * The packing slips of the orders ticked in the list (`?ids=` a comma-separated list of up to 50
 * seller order ids), on one printable page. Ids that are not order ids are dropped before any read.
 */
export default async function PackingSlipsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ ids?: string | string[] }>;
}) {
  const { ids } = await searchParams;
  const asked = (Array.isArray(ids) ? ids.join(',') : (ids ?? ''))
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => isUuid(id) && id[14] === '7');
  const t = await getTranslations();
  const message = (kind: 'none' | 'no-access') => (
    <div className="p-6">
      <EmptyState
        size="page"
        icon={kind === 'no-access' ? 'lock' : 'clipboard'}
        title={t(kind === 'no-access' ? 'catalog.no-access.title' : 'orders.slip.many-none')}
        body={t(kind === 'no-access' ? 'catalog.no-access.body' : 'orders.slip.many-none-help')}
        action={<BackLink href="/orders" label={t('orders.back')} />}
      />
    </div>
  );
  if (asked.length === 0) return message('none');
  const page = await loadPackingSlips(asked.slice(0, SLIPS_MAX));
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
  if (page.kind === 'no-access') return message('no-access');
  return <PackingSlips orders={page.orders} skipped={page.skipped} unreadable={page.unreadable} />;
}
