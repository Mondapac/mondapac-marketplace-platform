import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AccountDeletionSettingsPanel } from '../../../../src/account-deletion/settings-panel.tsx';
import {
  REQUESTS_PAGE_SIZE,
  REQUESTS_PATH,
  REQUESTS_VIEW_PERMISSION,
  SETTINGS_MANAGE_PERMISSION,
  SETTINGS_PATH,
  SETTINGS_VIEW_PERMISSION,
  type AccountDeletionSettingsAnswer,
  type DeletionRequestPage,
  type PendingCount,
} from '../../../../src/account-deletion/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsTabs, settingsTabLabels } from '../../../../src/settings/settings-tabs.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('account-deletion.settings.card') };
}

export default async function AccountDeletionSettingsPage() {
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
      <SettingsTabs active="account-deletion" labels={settingsTabLabels(t, permissionKeys)} />
      {body}
    </AdminShell>
  );
  if (!permissionKeys.includes(SETTINGS_VIEW_PERMISSION)) {
    return shell(
      <>
        <p className="text-fg-muted">{t('account-deletion.settings.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('settings.back-home')}
          </a>
        </p>
      </>,
    );
  }
  const read = await serverGet<AccountDeletionSettingsAnswer>(SETTINGS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <LoadError
        message={t('account-deletion.settings.load-failed')}
        retryLabel={t('load.retry')}
      />,
    );
  }
  // The API has no count: the first page of the list tells it ("100+" when more pages exist).
  let pending: PendingCount = { state: 'hidden' };
  if (permissionKeys.includes(REQUESTS_VIEW_PERMISSION)) {
    const list = await serverGet<DeletionRequestPage>(
      `${REQUESTS_PATH}?limit=${REQUESTS_PAGE_SIZE}`,
    );
    if (list.kind === 'signed-out') redirect('/session-ended');
    pending =
      list.kind === 'ok'
        ? { state: 'ok', count: list.body.entries.length, more: list.body.nextCursor !== null }
        : { state: 'unavailable' };
  }
  return shell(
    <AccountDeletionSettingsPanel
      initial={read.body}
      canManage={permissionKeys.includes(SETTINGS_MANAGE_PERMISSION)}
      pending={pending}
      csrfToken={csrfToken}
    />,
  );
}
