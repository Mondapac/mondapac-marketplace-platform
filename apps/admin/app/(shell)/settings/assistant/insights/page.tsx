import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { AssistantInsights } from '../../../../../src/assistant-insights/insights-view.tsx';
import { INSIGHTS_VIEW_PERMISSION } from '../../../../../src/assistant-insights/types.ts';
import { panelHostFor } from '../../../../../src/server/bff.ts';
import { panelConfig } from '../../../../../src/server/config.ts';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { SettingsShell } from '../../../../../src/server/settings-shell.tsx';
import { localZone } from '../../../../../src/shared/format.ts';
import { AssistantTabs } from '../../../../../src/settings/assistant-tabs.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('settings.assistant.insights-title') };
}

/**
 * Settings > Shopping assistant > Insights: conversations, spend, ratings and the unanswered
 * questions of the buyer assistant (a super list). Needs `assistant.settings.view`.
 */
export default async function AssistantInsightsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('settings.assistant.insights-title');
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="assistant" title={title}>
      {body}
    </SettingsShell>
  );
  if (!gate.session.permissionKeys.includes(INSIGHTS_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        pageTitle={title}
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('settings.assistant.permission-view'),
        })}
        backHref="/settings"
        backLabel={t('settings.sub.back')}
      />,
    );
  }
  // List paging (settings): page numbers only when the Market says so.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return shell(
    <SettingsPage
      title={title}
      description={t('settings.assistant.insights-intro')}
      banner={<AssistantTabs active="insights" />}
    >
      <AssistantInsights
        paging={paging}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        accountId={gate.session.accountId}
        marketId={marketId}
        csrfToken={gate.session.csrfToken}
      />
    </SettingsPage>,
  );
}
