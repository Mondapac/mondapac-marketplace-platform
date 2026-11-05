import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ListsSettingsPanel } from '../../../../src/lists-settings/lists-settings-panel.tsx';
import {
  SETTINGS_MANAGE_PERMISSION,
  SETTINGS_PATH,
  SETTINGS_VIEW_PERMISSION,
  type MarketSettingsAnswer,
} from '../../../../src/lists-settings/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('lists-settings.title') };
}

export default async function ListsSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('lists-settings.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="lists" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(SETTINGS_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('lists-settings.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<MarketSettingsAnswer>(SETTINGS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('lists-settings.load-failed')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <ListsSettingsPanel
      initial={read.body}
      canManage={permissionKeys.includes(SETTINGS_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
