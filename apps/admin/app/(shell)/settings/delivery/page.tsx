import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DeliverySettingsPanel } from '../../../../src/delivery-settings/delivery-settings-panel.tsx';
import {
  DELIVERY_MANAGE_PERMISSION,
  DELIVERY_SETTINGS_PATH,
  DELIVERY_VIEW_PERMISSION,
  type DeliverySettings,
} from '../../../../src/delivery-settings/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('deliverySettings.title') };
}

export default async function DeliverySettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('deliverySettings.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="delivery" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(DELIVERY_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('deliverySettings.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<DeliverySettings>(DELIVERY_SETTINGS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('deliverySettings.unavailable')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <DeliverySettingsPanel
      initial={read.body}
      canManage={permissionKeys.includes(DELIVERY_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
