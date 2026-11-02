import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { BusinessActivitiesView } from '../../../../src/business-activities/business-activities-view.tsx';
import { EDIT_PERMISSION, READ_PERMISSION } from '../../../../src/business-activities/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';

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
  const title = t('business-activities.title');
  const { permissionKeys, csrfToken } = gate.session;
  return (
    <AdminShell session={gate.session} activeId="business-activities" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(READ_PERMISSION) ? (
        <BusinessActivitiesView
          canEdit={permissionKeys.includes(EDIT_PERMISSION)}
          csrfToken={csrfToken}
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
