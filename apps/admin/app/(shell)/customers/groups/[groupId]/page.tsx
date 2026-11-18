import { BackLink, LoadError } from '@mondapac/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { GroupPage } from '../../../../../src/customers/group-page.tsx';
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
  return { title: t('customers.groups.page-title') };
}

/** One manual customer group and its members (customers management phase 2a). */
export default async function CustomerGroupPage({
  params,
}: {
  readonly params: Promise<{ readonly groupId: string }>;
}) {
  const { groupId } = await params;
  if (!UUID.test(groupId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('customers.groups.title');
  const keys = gate.session.permissionKeys;
  if (!keys.includes(VIEW_PERMISSION)) {
    return (
      <AdminShell session={gate.session} activeId="customer-groups" title={title}>
        <div className="flex flex-col gap-4">
          <BackLink href="/customers/groups" label={t('customers.groups.back')} />
          <p className="text-fg-muted">{t('customers.no-access')}</p>
        </div>
      </AdminShell>
    );
  }
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const config = panelConfig();
  const marketId = panelHostFor(config, (await headers()).get('host'))?.marketId ?? '';
  return (
    <AdminShell session={gate.session} activeId="customer-groups" title={title}>
      <GroupPage
        groupId={groupId.toLowerCase()}
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
