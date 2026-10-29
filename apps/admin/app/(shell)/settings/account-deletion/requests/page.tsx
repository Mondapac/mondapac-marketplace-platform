import { BackLink, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { RequestsList } from '../../../../../src/account-deletion/requests-list.tsx';
import {
  BUYER_DELETE_PERMISSION,
  REQUESTS_VIEW_PERMISSION,
  SETTINGS_HREF,
} from '../../../../../src/account-deletion/types.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('account-deletion.requests.title') };
}

export default async function DeletionRequestsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('account-deletion.requests.title');
  const keys = new Set(gate.session.permissionKeys);
  return (
    <AdminShell session={gate.session} activeId="settings" title={title}>
      <BackLink href={SETTINGS_HREF} label={t('account-deletion.requests.back')} />
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {keys.has(REQUESTS_VIEW_PERMISSION) ? (
        <RequestsList
          canCancel={keys.has(BUYER_DELETE_PERMISSION)}
          csrfToken={gate.session.csrfToken}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('account-deletion.requests.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('settings.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
