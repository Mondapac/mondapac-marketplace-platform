import { LoadError } from '@mondapac/ui';
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
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <SettingsTabs active="assistant" labels={settingsTabLabels(t, permissionKeys)} />
      {body}
    </AdminShell>
  );
  if (!permissionKeys.includes(ASSISTANT_VIEW_PERMISSION)) {
    return shell(
      <>
        <p className="text-fg-muted">{t('settings.assistant.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('settings.back-home')}
          </a>
        </p>
      </>,
    );
  }
  const read = await serverGet<AssistantSettingsAnswer>(ASSISTANT_SETTINGS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <LoadError message={t('settings.assistant.unavailable')} retryLabel={t('load.retry')} />,
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
