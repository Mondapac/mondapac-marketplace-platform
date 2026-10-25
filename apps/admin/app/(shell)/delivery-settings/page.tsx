import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DeliverySettingsPanel } from '../../../src/delivery-settings/delivery-settings-panel.tsx';
import {
  DELIVERY_MANAGE_PERMISSION,
  DELIVERY_SETTINGS_PATH,
  DELIVERY_VIEW_PERMISSION,
  type DeliverySettings,
} from '../../../src/delivery-settings/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';

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
    <AdminShell session={gate.session} activeId="delivery-settings" title={title}>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      <p className="mb-6 max-w-prose text-fg-muted">{t('deliverySettings.intro')}</p>
      {body}
    </AdminShell>
  );
  if (!permissionKeys.includes(DELIVERY_VIEW_PERMISSION)) {
    return shell(
      <>
        <p className="text-fg-muted">{t('deliverySettings.no-access')}</p>
        <p className="mt-4">
          <a className="inline-flex min-h-12 items-center font-medium text-link underline" href="/">
            {t('deliverySettings.back-home')}
          </a>
        </p>
      </>,
    );
  }
  const read = await serverGet<DeliverySettings>(DELIVERY_SETTINGS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <LoadError message={t('deliverySettings.unavailable')} retryLabel={t('load.retry')} />,
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
