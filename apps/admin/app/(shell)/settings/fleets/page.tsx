import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FleetSelectionPanel } from '../../../../src/fleet-selection/fleet-selection-panel.tsx';
import {
  FLEET_MANAGE_PERMISSION,
  FLEET_SELECTION_PATH,
  FLEET_VIEW_PERMISSION,
  type Selection,
} from '../../../../src/fleet-selection/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('fleets.title') };
}

export default async function FleetSelectionPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('fleets.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="fleets" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(FLEET_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('fleets.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<Selection>(FLEET_SELECTION_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('fleets.unavailable')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <FleetSelectionPanel
      initial={read.body}
      canManage={permissionKeys.includes(FLEET_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
