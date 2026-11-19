import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ShipToRetentionPanel } from '../../../../src/ship-to-retention/retention-panel.tsx';
import {
  SHIP_TO_RETENTION_MANAGE_PERMISSION,
  SHIP_TO_RETENTION_PATH,
  SHIP_TO_RETENTION_VIEW_PERMISSION,
  type ShipToRetention,
} from '../../../../src/ship-to-retention/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { displayZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('ship-to-retention.title') };
}

export default async function ShipToRetentionSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('ship-to-retention.title');
  const { permissionKeys, csrfToken, timezone } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="ship-to-retention" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(SHIP_TO_RETENTION_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('ship-to-retention.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<ShipToRetention>(SHIP_TO_RETENTION_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('ship-to-retention.unavailable')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <ShipToRetentionPanel
      initial={read.body}
      canManage={permissionKeys.includes(SHIP_TO_RETENTION_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
      zone={displayZone(timezone)}
    />,
  );
}
