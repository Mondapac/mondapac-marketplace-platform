import { LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { RequestsList } from '../../../../src/account-deletion/requests-list.tsx';
import { isView, type View } from '../../../../src/account-deletion/list/requests-list-types.ts';
import { REQUESTS_VIEW_PERMISSION } from '../../../../src/account-deletion/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('account-deletion.requests.title') };
}

const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Account deletion requests (list 25): the Market's buyer deletion requests as a super list, under
 * Customers in the main menu (settings navigation design, phase 2a: daily work, not a setting; the
 * old Settings address redirects here). A link
 * may open a view (`?view=`); the page reads the Market's List paging setting and hands the list
 * its zone, and the list reads its own rows. Cancelling stays with its own permission: the list
 * shows it in a row only when the API names it.
 */
export default async function DeletionRequestsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly view?: string | readonly string[] }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('account-deletion.requests.title');
  const keys = new Set(gate.session.permissionKeys);
  const allowed = keys.has(REQUESTS_VIEW_PERMISSION);
  const asked = one((await searchParams).view);
  const view: View = isView(asked) ? asked : 'pending';
  // List paging (settings): page numbers only when the Market says so; a value that cannot be
  // read (or may not be read) means Previous and next. Not read without the view permission.
  const [mode, host] = allowed
    ? await Promise.all([
        serverGet<{ readonly listPaging: string }>('settings/admin/list-paging'),
        headers(),
      ])
    : [null, null];
  const paging = mode?.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId =
    host === null ? '' : (panelHostFor(panelConfig(), host.get('host'))?.marketId ?? '');
  return (
    <AdminShell session={gate.session} activeId="deletion-requests" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {allowed ? (
        <RequestsList
          // A link to another view is a fresh list.
          key={view}
          initialView={view}
          paging={paging}
          accountId={gate.session.accountId}
          csrfToken={gate.session.csrfToken}
          marketId={marketId}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        />
      ) : (
        <NoAccess
          pageTitle={title}
          title={t('settings.no-access-title')}
          body={t('settings.no-access-needs', {
            page: title,
            permission: t('account-deletion.requests.permission-view'),
          })}
          backHref="/"
          backLabel={t('settings.back-home')}
        />
      )}
    </AdminShell>
  );
}
