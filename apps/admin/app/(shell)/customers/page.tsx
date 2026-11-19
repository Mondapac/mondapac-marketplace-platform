import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { CustomersList } from '../../../src/customers/customers-list.tsx';
import { VIEW_PERMISSION } from '../../../src/customers/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { localZone } from '../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.title') };
}

export default async function CustomersPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('customers.title');
  const keys = gate.session.permissionKeys;
  if (!keys.includes(VIEW_PERMISSION)) {
    return (
      <AdminShell session={gate.session} activeId="customers" title={title}>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('customers.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('customers.back-home')}
          </a>
        </p>
      </AdminShell>
    );
  }
  // List paging (settings): page numbers only when the Market says so; a value that cannot be
  // read means Previous and next.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const config = panelConfig();
  const marketId = panelHostFor(config, (await headers()).get('host'))?.marketId ?? '';
  return (
    <AdminShell session={gate.session} activeId="customers" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <CustomersList
        accountId={gate.session.accountId}
        marketId={marketId}
        marketName={config.marketName}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        paging={paging}
        permissionKeys={keys}
        csrfToken={gate.session.csrfToken}
      />
    </AdminShell>
  );
}
