import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { BusinessActivitiesView } from '../../../../src/business-activities/business-activities-view.tsx';
import { EDIT_PERMISSION, READ_PERMISSION } from '../../../../src/business-activities/types.ts';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { headers } from 'next/headers';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('business-activities.title') };
}

export default async function BusinessActivitiesPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  // List paging (settings): page numbers only when the Market says so; unreadable means Previous and next.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const title = t('business-activities.title');
  const { permissionKeys, csrfToken } = gate.session;
  return (
    <AdminShell session={gate.session} activeId="business-activities" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(READ_PERMISSION) ? (
        <BusinessActivitiesView
          canEdit={permissionKeys.includes(EDIT_PERMISSION)}
          csrfToken={csrfToken}
          paging={paging}
          accountId={gate.session.accountId}
          marketId={marketId}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('business-activities.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('business-activities.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
