import { LoadError } from '@mondapac/ui';
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
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      <p className="mb-6 max-w-prose text-fg-muted">{t('fleets.intro')}</p>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(FLEET_VIEW_PERMISSION)) {
    return shell(
      <>
        <p className="text-fg-muted">{t('fleets.no-access')}</p>
        <p className="mt-4">
          <a className="inline-flex min-h-12 items-center font-medium text-link underline" href="/">
            {t('fleets.back-home')}
          </a>
        </p>
      </>,
    );
  }
  const read = await serverGet<Selection>(FLEET_SELECTION_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(<LoadError message={t('fleets.unavailable')} retryLabel={t('load.retry')} />);
  }
  return shell(
    <FleetSelectionPanel
      initial={read.body}
      canManage={permissionKeys.includes(FLEET_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
