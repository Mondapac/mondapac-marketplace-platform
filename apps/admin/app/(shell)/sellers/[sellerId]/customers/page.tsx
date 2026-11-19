import { BackLink, LoadError } from '@mondapac/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { SellerCustomersTab } from '../../../../../src/customers/seller-customers-tab.tsx';
import { VIEW_PERMISSION } from '../../../../../src/customers/types.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../../src/server/bff.ts';
import { panelConfig } from '../../../../../src/server/config.ts';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { localZone } from '../../../../../src/shared/format.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.seller-tab.title') };
}

/** The Customers tab of a seller (customers management phase 3): counts, trend and the list. */
export default async function SellerCustomersPage({
  params,
}: {
  readonly params: Promise<{ readonly sellerId: string }>;
}) {
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('customers.seller-tab.title');
  const { session } = gate;
  let body = <p className="text-fg-muted">{t('customers.seller-tab.no-access')}</p>;
  if (session.permissionKeys.includes(VIEW_PERMISSION)) {
    // List paging (settings): page numbers only when the Market says so.
    const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
    const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
    const config = panelConfig();
    const marketId = panelHostFor(config, (await headers()).get('host'))?.marketId ?? '';
    body = (
      <SellerCustomersTab
        sellerId={sellerId}
        accountId={session.accountId}
        marketId={marketId}
        zone={localZone(session.timezone, session.marketTimezone)}
        paging={paging}
        csrfToken={session.csrfToken}
      />
    );
  }
  return (
    <AdminShell session={session} activeId="sellers" title={title}>
      <div className="mb-4 flex flex-col items-start gap-2">
        <BackLink href={`/sellers/${sellerId}`} label={t('customers.seller-tab.back')} />
        <h1 className="text-2xl font-semibold">{title}</h1>
      </div>
      {body}
    </AdminShell>
  );
}
