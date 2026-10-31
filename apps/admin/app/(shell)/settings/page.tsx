import { LoadError, NoAccess, RecentPages } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';
import { SettingsHub } from '../../../src/settings/settings-hub.tsx';
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
          <header>
            <h1 className="text-2xl font-semibold text-fg">{title}</h1>
            <p className="mt-1 max-w-prose text-sm text-fg-muted">
              {t('settings.hub.description')}
            </p>
          </header>
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
