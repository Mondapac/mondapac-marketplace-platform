import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { queryFromParams } from '../../../src/orders/orders-query.ts';
import { OrdersList } from '../../../src/orders/orders-list.tsx';
import { VIEW_PERMISSION } from '../../../src/orders/types.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { requireSession } from '../../../src/server/session.ts';
import { localZone } from '../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.page-title') };
}

export default async function OrdersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('orders.title');
  const raw = await searchParams;
  const initialQuery = queryFromParams(
    Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
    ),
  );
  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of orders.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return (
    <AdminShell session={gate.session} activeId="orders" title={title}>
      {gate.session.permissionKeys.includes(VIEW_PERMISSION) ? (
        <OrdersList
          key={JSON.stringify(initialQuery)}
          title={title}
          paging={paging}
          initialQuery={initialQuery}
          accountId={gate.session.accountId}
          marketId={marketId}
          csrfToken={gate.session.csrfToken}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        />
      ) : (
        <>
          <PageHeader title={title} className="mb-4" />
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
