import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ServiceAreaNamesPanel } from '../../../../src/service-area-names/service-area-names-panel.tsx';
import {
  AREAS_EDIT_PERMISSION,
  AREAS_PATH,
  AREAS_VIEW_PERMISSION,
  type AreaNames,
} from '../../../../src/service-area-names/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('serviceAreas.title') };
}

export default async function ServiceAreaNamesPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('serviceAreas.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="service-areas" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(AREAS_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('serviceAreas.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<AreaNames>(AREAS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('serviceAreas.unavailable')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <ServiceAreaNamesPanel
      initial={read.body}
      canEdit={permissionKeys.includes(AREAS_EDIT_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
