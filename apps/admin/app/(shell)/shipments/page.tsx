import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { toId } from '../../../src/sales/search-route.ts';
import { ShipmentsList } from '../../../src/sales/shipments/shipments-list.tsx';
import { VIEW_PERMISSION } from '../../../src/sales/shipments/shipments-types.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { requireSession } from '../../../src/server/session.ts';
import { localZone } from '../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('shipments.page-title') };
}

export default async function ShipmentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly sellerId?: string | readonly string[] }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('shipments.title');
  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of shipments.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  // A link from a seller page may name one seller; anything that is not a UUID v7 is ignored; the API wants it lower-case.
  const { sellerId } = await searchParams;
  const seller = typeof sellerId === 'string' ? toId(sellerId) : null;
  return (
    <AdminShell session={gate.session} activeId="shipments" title={title}>
      <PageHeader title={title} className="mb-4" />
      {gate.session.permissionKeys.includes(VIEW_PERMISSION) ? (
        <ShipmentsList
          paging={paging}
          accountId={gate.session.accountId}
          marketId={marketId}
          csrfToken={gate.session.csrfToken}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
          sellerId={seller}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('shipments.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('shipments.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
