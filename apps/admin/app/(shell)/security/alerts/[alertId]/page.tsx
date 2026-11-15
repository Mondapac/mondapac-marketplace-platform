import { BackLink, LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AlertDetailView } from '../../../../../src/security-centre/alert-detail.tsx';
import {
  SecurityFrame,
  SecurityNoAccess,
  SecurityUnavailable,
} from '../../../../../src/security-centre/frame.tsx';
import {
  RESPOND_PERMISSION,
  S1_MAX_STEPS,
  VIEW_PERMISSION,
  type AlertDetail,
  type OnCall,
} from '../../../../../src/security-centre/types.ts';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { localZone } from '../../../../../src/shared/format.ts';

const ALERT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('security-centre.detail.page-title') };
}

/**
 * One security alert (design v3, screen 3): a page of its own, so a row and the top-bar badge are
 * real links (Reza M5). The on-call view names who may resolve a critical alert.
 */
export default async function SecurityAlertPage({
  params,
}: {
  readonly params: Promise<{ readonly alertId: string }>;
}) {
  const { alertId } = await params;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const back = <BackLink href="/security/alerts" label={t('security-centre.detail.back')} />;
  if (!session.permissionKeys.includes(VIEW_PERMISSION)) {
    return (
      <SecurityFrame session={session} tab={null}>
        <SecurityNoAccess />
      </SecurityFrame>
    );
  }
  // Only an id of the API's shape reaches it: "..", for one, would change the path it reads.
  if (!ALERT_ID.test(alertId)) {
    return (
      <SecurityFrame session={session} tab={null}>
        <div className="mb-4">{back}</div>
        <h2 className="text-lg font-semibold">{t('security-centre.not-found-title')}</h2>
        <p className="mt-1 text-fg-muted">{t('security-centre.not-found')}</p>
      </SecurityFrame>
    );
  }
  const [alert, onCall] = await Promise.all([
    serverGet<AlertDetail>(`security/admin/alerts/${encodeURIComponent(alertId)}`),
    serverGet<OnCall>('security/admin/on-call'),
  ]);
  if (alert.kind === 'signed-out' || onCall.kind === 'signed-out') redirect('/session-ended');
  if (alert.kind !== 'ok') {
    return (
      <SecurityFrame session={session} tab={null}>
        <div className="mb-4">{back}</div>
        {alert.kind === 'forbidden' ? (
          <SecurityNoAccess />
        ) : alert.kind === 'not-found' ? (
          <>
            <h2 className="text-lg font-semibold">{t('security-centre.not-found-title')}</h2>
            <p className="mt-1 text-fg-muted">{t('security-centre.not-found')}</p>
          </>
        ) : (
          <SecurityUnavailable message={t('security-centre.error.alerts')} />
        )}
      </SecurityFrame>
    );
  }
  const roster = onCall.kind === 'ok' ? onCall.body : null;
  return (
    <SecurityFrame session={session} tab={null} pageTitle={alert.body.title}>
      <AlertDetailView
        initial={alert.body}
        zone={localZone(session.timezone, session.marketTimezone)}
        canRespond={session.permissionKeys.includes(RESPOND_PERMISSION)}
        resolvers={
          // A failed read is not "no roster": the hint then names no one instead.
          roster?.configured === false
            ? null
            : {
                commander: roster?.incidentCommander?.name ?? null,
                owner: roster?.securityOwner?.name ?? null,
              }
        }
        csrfToken={session.csrfToken}
        maxSteps={roster?.escalationMaxSteps ?? S1_MAX_STEPS}
      />
    </SecurityFrame>
  );
}
