import { LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { ReviewPolicyPanel } from '../../../../src/system-requests/review-policy.tsx';
import {
  POLICY_MANAGE_PERMISSION,
  POLICY_VIEW_PERMISSION,
  VIEW_PERMISSION,
} from '../../../../src/system-requests/types.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('system-requests.policy.title') };
}

export default async function ReviewPolicyPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('system-requests.policy.title');
  const { permissionKeys, csrfToken } = gate.session;
  return (
    <SettingsShell session={gate.session} linkId="review-policy" title={title}>
      {permissionKeys.includes(POLICY_VIEW_PERMISSION) ? (
        <ReviewPolicyPanel
          canManage={permissionKeys.includes(POLICY_MANAGE_PERMISSION)}
          canSeeRequests={permissionKeys.includes(VIEW_PERMISSION)}
          csrfToken={csrfToken}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        />
      ) : (
        <NoAccess
          pageTitle={title}
          title={t('settings.no-access-title')}
          body={t('settings.no-access-needs', {
            page: title,
            permission: t('system-requests.policy.permission-view'),
          })}
          backHref="/settings"
          backLabel={t('settings.sub.back')}
        />
      )}
    </SettingsShell>
  );
}
