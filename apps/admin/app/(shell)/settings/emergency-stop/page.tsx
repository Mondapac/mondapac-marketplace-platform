import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { EmergencyStopPanel } from '../../../../src/offer-review-emergency-stop/emergency-stop-panel.tsx';
import {
  EMERGENCY_STOP_PATH,
  EMERGENCY_STOP_PERMISSION,
  emergencyStopOf,
} from '../../../../src/offer-review-emergency-stop/types.ts';
import { OFFER_REVIEW_VIEW_PERMISSION } from '../../../../src/offer-review-settings/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('emergency-stop.page.title') };
}

/** Settings › Catalogue › Emergency stop: the Offer review emergency stop (R0). */
export default async function EmergencyStopPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('emergency-stop.page.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="emergency-stop" title={title}>
      {body}
    </SettingsShell>
  );
  const canSwitch = permissionKeys.includes(EMERGENCY_STOP_PERMISSION);
  if (!canSwitch && !permissionKeys.includes(OFFER_REVIEW_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('offer-review-settings.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<unknown>(EMERGENCY_STOP_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  const answer = read.kind === 'ok' ? emergencyStopOf(read.body) : null;
  if (answer === null) {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('emergency-stop.page.load-failed')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <EmergencyStopPanel
      initial={answer}
      canSwitch={canSwitch}
      csrfToken={csrfToken}
      zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
    />,
  );
}
