import { LoadError, NoAccess, SettingsPage as SettingsFrame } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { ASSISTANT_VIEW_PERMISSION } from '../../../src/settings/assistant-types.ts';
import { SettingsTabs, settingsTabLabels } from '../../../src/settings/settings-tabs.tsx';
import { SupportEmailCard } from '../../../src/settings/support-email-card.tsx';
import {
  SUPPORT_MANAGE_PERMISSION,
  SUPPORT_VIEW_PERMISSION,
  type SupportContact,
} from '../../../src/settings/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('settings.title') };
}

export default async function SettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('settings.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="settings" title={title}>
      <SettingsTabs active="general" labels={settingsTabLabels(t, permissionKeys)} />
      {body}
    </AdminShell>
  );
  if (!permissionKeys.includes(SUPPORT_VIEW_PERMISSION)) {
    // An admin who may see only the assistant tab lands on it.
    if (permissionKeys.includes(ASSISTANT_VIEW_PERMISSION)) redirect('/settings/assistant');
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: t('settings.support.title'),
          permission: t('settings.support.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<SupportContact>('notifications/admin/support-contact');
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsFrame title={t('settings.support.title')}>
        <LoadError
          message={t('settings.unavailable')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsFrame>,
    );
  }
  return shell(
    <SupportEmailCard
      initial={read.body}
      canManage={permissionKeys.includes(SUPPORT_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
