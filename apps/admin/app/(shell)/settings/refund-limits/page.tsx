import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { RefundLimitsPanel } from '../../../../src/refund-limits/market-panel.tsx';
import {
  REFUND_LIMITS_MANAGE_PERMISSION,
  REFUND_LIMITS_PATH,
  REFUND_LIMITS_VIEW_PERMISSION,
  type RefundLimits,
} from '../../../../src/refund-limits/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { displayZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('refund-limits.title') };
}

export default async function RefundLimitsSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('refund-limits.title');
  const { permissionKeys, csrfToken, timezone } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="refund-limits" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(REFUND_LIMITS_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('refund-limits.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<RefundLimits>(REFUND_LIMITS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('refund-limits.unavailable')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <RefundLimitsPanel
      initial={read.body}
      canManage={permissionKeys.includes(REFUND_LIMITS_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
      zone={displayZone(timezone)}
    />,
  );
}
