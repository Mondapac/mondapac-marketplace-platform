import { BackLink, LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import {
  BUYER_DELETE_PERMISSION,
  SETTINGS_PATH,
  SETTINGS_VIEW_PERMISSION,
  type AccountDeletionSettingsAnswer,
} from '../../../../src/account-deletion/types.ts';
import { CustomerPage } from '../../../../src/customers/customer-page.tsx';
import { isTab } from '../../../../src/customers/page-types.ts';
import { VIEW_PERMISSION } from '../../../../src/customers/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.page.page-title') };
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly accountId: string }>;
  readonly searchParams: Promise<{ readonly tab?: string | string[] }>;
}) {
  const { accountId } = await params;
  if (!UUID.test(accountId)) notFound();
  const { tab } = await searchParams;
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
        <div className="flex flex-col gap-4">
          <BackLink href="/customers" label={t('customers.page.back')} />
          <p className="text-fg-muted">{t('customers.no-access')}</p>
        </div>
      </AdminShell>
    );
  }
  // The waiting period shows in the delete dialog only to an admin who may read the setting.
  let waitingPeriodDays: number | null = null;
  if (keys.includes(BUYER_DELETE_PERMISSION) && keys.includes(SETTINGS_VIEW_PERMISSION)) {
    const read = await serverGet<AccountDeletionSettingsAnswer>(SETTINGS_PATH);
    if (read.kind === 'signed-out') redirect('/session-ended');
    if (read.kind === 'ok') waitingPeriodDays = read.body.settings.waitingPeriodDays;
  }
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const asked = Array.isArray(tab) ? tab[0] : tab;
  return (
    <AdminShell session={gate.session} activeId="customers" title={title}>
      <CustomerPage
        accountId={accountId.toLowerCase()}
        adminAccountId={gate.session.accountId}
        marketId={marketId}
        initialTab={isTab(asked) ? asked : 'overview'}
        permissionKeys={keys}
        csrfToken={gate.session.csrfToken}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        paging={paging}
        waitingPeriodDays={waitingPeriodDays}
      />
    </AdminShell>
  );
}
