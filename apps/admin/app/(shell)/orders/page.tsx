import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { OrdersList } from '../../../src/orders/orders-list.tsx';
import { VIEW_PERMISSION } from '../../../src/orders/types.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.page-title') };
}

export default async function OrdersPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('orders.title');
  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of orders.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  return (
    <AdminShell session={gate.session} activeId="orders" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {gate.session.permissionKeys.includes(VIEW_PERMISSION) ? (
        <OrdersList paging={paging} />
      ) : (
        <>
          <p className="text-fg-muted">{t('orders.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('orders.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
