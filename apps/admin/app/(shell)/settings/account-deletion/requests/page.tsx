import { BackLink, LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { RequestsList } from '../../../../../src/account-deletion/requests-list.tsx';
import {
  BUYER_DELETE_PERMISSION,
  REQUESTS_VIEW_PERMISSION,
  SETTINGS_HREF,
} from '../../../../../src/account-deletion/types.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { SettingsShell } from '../../../../../src/server/settings-shell.tsx';

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
    // Nested: the breadcrumb is Settings / Marketplace / Account deletion, then this page.
    <SettingsShell session={gate.session} linkId="account-deletion" title={title} nested>
      <BackLink href={SETTINGS_HREF} label={t('account-deletion.requests.back')} />
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {keys.has(REQUESTS_VIEW_PERMISSION) ? (
        <RequestsList
          canCancel={keys.has(BUYER_DELETE_PERMISSION)}
          csrfToken={gate.session.csrfToken}
        />
      ) : (
        <NoAccess
          title={t('settings.no-access-title')}
          body={t('settings.no-access-needs', {
            page: title,
            permission: t('account-deletion.requests.permission-view'),
          })}
          backHref="/"
          backLabel={t('settings.back-home')}
        />
      )}
    </SettingsShell>
  );
}
