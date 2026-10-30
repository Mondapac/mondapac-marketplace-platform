import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { AssistantSettingsPanel } from '../../../../src/settings/assistant-settings-panel.tsx';
import {
  ASSISTANT_MANAGE_PERMISSION,
  ASSISTANT_SETTINGS_PATH,
  ASSISTANT_VIEW_PERMISSION,
  type AssistantSettingsAnswer,
} from '../../../../src/settings/assistant-types.ts';
import { SettingsTabs, settingsTabLabels } from '../../../../src/settings/settings-tabs.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('settings.assistant.title') };
}

export default async function AssistantSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('settings.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="settings" title={title}>
      <SettingsTabs active="assistant" labels={settingsTabLabels(t, permissionKeys)} />
      {body}
    </AdminShell>
  );
  if (!permissionKeys.includes(ASSISTANT_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: t('settings.assistant.title'),
          permission: t('settings.assistant.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<AssistantSettingsAnswer>(ASSISTANT_SETTINGS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={t('settings.assistant.title')}>
        <LoadError
          message={t('settings.assistant.unavailable')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <AssistantSettingsPanel
      initial={read.body}
      canManage={permissionKeys.includes(ASSISTANT_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
