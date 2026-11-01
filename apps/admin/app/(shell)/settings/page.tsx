import { LoadError, NoAccess, RecentPages, SettingsHub, SettingsHubHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';
import { visibleSettings } from '../../../src/settings/settings-nav.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('settings.title') };
}

/** The Settings hub: every settings page the admin may open, grouped by topic. */
export default async function SettingsHubPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('settings.title');
  const groups = visibleSettings(gate.session.permissionKeys);
  return (
    <AdminShell session={gate.session} activeId="settings" title={title}>
      {groups.length === 0 ? (
        <NoAccess
          title={t('settings.hub.no-access-title')}
          body={t('settings.hub.no-access-body')}
          backHref="/"
          backLabel={t('settings.back-home')}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <SettingsHubHeader title={title} description={t('settings.hub.description')} />
          <RecentPages heading={t('palette.recent-heading')} />
          <SettingsHub
            groups={groups}
            label={(key) => t(key)}
            labels={{ viewOnly: t('settings.hub.view-only') }}
          />
        </div>
      )}
    </AdminShell>
  );
}
