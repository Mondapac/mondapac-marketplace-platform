import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AiGatewayPanel } from '../../../../src/ai-gateway/ai-gateway-panel.tsx';
import {
  GATEWAY_MANAGE_PERMISSION,
  GATEWAY_PATH,
  GATEWAY_VIEW_PERMISSION,
  settingsOf,
} from '../../../../src/ai-gateway/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('ai-gateway.title') };
}

/** Settings › AI Gateway: the emergency stop, capability switches, caps and their history. */
export default async function AiGatewayPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('ai-gateway.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="ai-gateway" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(GATEWAY_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('ai-gateway.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const answer = await serverGet<unknown>(GATEWAY_PATH);
  if (answer.kind === 'signed-out') redirect('/session-ended');
  const rows = answer.kind === 'ok' ? settingsOf(answer.body) : null;
  if (rows === null) {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('ai-gateway.load-failed')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <AiGatewayPanel
      initial={rows}
      canManage={permissionKeys.includes(GATEWAY_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
