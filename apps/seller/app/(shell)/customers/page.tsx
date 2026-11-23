import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { CustomersList } from '../../../src/customers/customers-list.tsx';
import {
  CUSTOMERS_EXPORT_PERMISSION,
  CUSTOMERS_VIEW_PERMISSION,
  INVITE_LINK_PERMISSION,
} from '../../../src/customers/types.ts';
import { panelHostFor } from '../../../src/server/bff.ts';
import { catalogGate } from '../../../src/server/catalog-page.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.title') };
}

export default async function CustomersPage() {
  const t = await getTranslations();
  const title = t('customers.title');
  const gate = await catalogGate(CUSTOMERS_VIEW_PERMISSION);
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('catalog.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (gate.kind === 'no-access') {
    return (
      <SellerShell session={gate.session} activeId="s_customers" title={title}>
        <PageHeader title={t('catalog.no-access.title')} className="mb-2" />
        <p className="text-fg-muted">{t('catalog.no-access.body')}</p>
      </SellerShell>
    );
  }
  const { session } = gate;
  // List paging (settings): page numbers only when the Market says so; unreadable means Previous and next.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/seller/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const keys = session.permissionKeys;
  return (
    <SellerShell session={session} activeId="s_customers" title={title}>
      <PageHeader title={title} className="mb-4" />
      <CustomersList
        paging={paging}
        accountId={session.accountId}
        marketId={marketId}
        csrfToken={session.csrfToken}
        canExport={keys.includes(CUSTOMERS_EXPORT_PERMISSION)}
        canInvite={keys.includes(INVITE_LINK_PERMISSION)}
      />
    </SellerShell>
  );
}
