import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AlertsList } from '../../../../src/security-centre/alerts-list.tsx';
import { SecurityFrame, SecurityNoAccess } from '../../../../src/security-centre/frame.tsx';
import { VIEW_PERMISSION } from '../../../../src/security-centre/types.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('security-centre.title') };
}

/**
 * Security > Alerts (design v3, screens 1-2): the live alerts first, read again every 30 s while
 * the tab is visible (F4). The list reads in the browser so a refresh keeps filters and focus.
 */
export default async function SecurityAlertsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  if (!session.permissionKeys.includes(VIEW_PERMISSION)) {
    return (
      <SecurityFrame session={session} tab={null}>
        <SecurityNoAccess />
      </SecurityFrame>
    );
  }
  return (
    <SecurityFrame session={session} tab="alerts">
      <AlertsList zone={localZone(session.timezone, session.marketTimezone)} />
    </SecurityFrame>
  );
}
