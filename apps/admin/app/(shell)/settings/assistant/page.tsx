import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { localZone } from '../../../../src/shared/format.ts';
import { averageCostUsd } from '../../../../src/assistant-insights/insights-math.ts';
import {
  INSIGHTS_PATH,
  INSIGHTS_VIEW_PERMISSION,
  type Insights,
} from '../../../../src/assistant-insights/types.ts';
import { AssistantTabs } from '../../../../src/settings/assistant-tabs.tsx';
import { AssistantSettingsPanel } from '../../../../src/settings/assistant-settings-panel.tsx';
import {
  ASSISTANT_MANAGE_PERMISSION,
  ASSISTANT_SETTINGS_PATH,
  ASSISTANT_VIEW_PERMISSION,
  type AssistantSettingsAnswer,
} from '../../../../src/settings/assistant-types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('settings.assistant.title') };
}

export default async function AssistantSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('settings.assistant.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="assistant" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(ASSISTANT_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        pageTitle={t('settings.assistant.title')}
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: t('settings.assistant.title'),
          permission: t('settings.assistant.permission-view'),
        })}
        backHref="/settings"
        backLabel={t('settings.sub.back')}
      />,
    );
  }
  const read = await serverGet<AssistantSettingsAnswer>(ASSISTANT_SETTINGS_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={t('settings.assistant.title')}>
        <LoadError
          title={t('settings.load-error.title', { page: title })}
          message={t('settings.load-error.body')}
          retryLabel={t('load.retry')}
          className="w-full"
        />
      </SettingsPage>,
    );
  }
  // The average cost of a conversation over the last 30 days (the route's default range); the
  // card says "not measured" when it cannot be read.
  const insights = permissionKeys.includes(INSIGHTS_VIEW_PERMISSION)
    ? await serverGet<Insights>(`${INSIGHTS_PATH}?page=1&pageSize=1`)
    : null;
  return shell(
    <AssistantSettingsPanel
      initial={read.body}
      zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
      tabs={<AssistantTabs active="settings" />}
      averageCostUsd={
        insights !== null && insights.kind === 'ok' ? averageCostUsd(insights.body.totals) : null
      }
      canManage={permissionKeys.includes(ASSISTANT_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
