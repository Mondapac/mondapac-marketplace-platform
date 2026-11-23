import { LoadError, NoAccess, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { QueueList } from '../../../src/system-requests/queue-list.tsx';
import { VIEW_PERMISSION } from '../../../src/system-requests/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { localZone } from '../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('system-requests.title') };
}

export default async function SystemRequestsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('system-requests.title');
  const allowed = gate.session.permissionKeys.includes(VIEW_PERMISSION);
  if (!allowed) {
    return (
      <AdminShell session={gate.session} activeId="system-requests" title={title}>
        <NoAccess
          title={t('system-requests.no-access')}
          body={t('system-requests.no-access-body')}
          backHref="/"
          backLabel={t('system-requests.back-home')}
        />
      </AdminShell>
    );
  }
  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of requests.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  // The address keeps the view, search and filters; only plain text values are read from it.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string') query.set(key, value);
  }
  return (
    <AdminShell session={gate.session} activeId="system-requests" title={title}>
      <PageHeader title={title} className="mb-4" />
      <QueueList
        accountId={gate.session.accountId}
        marketId={marketId}
        csrfToken={gate.session.csrfToken}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        paging={paging}
        initialSearch={query.toString()}
      />
    </AdminShell>
  );
}
