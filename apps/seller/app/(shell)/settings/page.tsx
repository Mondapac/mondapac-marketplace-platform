import { LoadError, NoAccess, RecentPages } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';
import { SETUP_ROOT } from '../../../src/setup/steps.ts';
import { SettingsHub } from '../../../src/settings/settings-hub.tsx';
import { visibleSettings } from '../../../src/settings/settings-nav.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('settings.title') };
}

/** The Settings hub: every settings page the seller's member may open, grouped by topic. */
export default async function SettingsHubPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  // Settings are for an approved seller; the others finish their file first.
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  const title = t('settings.title');
  const groups = visibleSettings(session.permissionKeys);
  return (
    <SellerShell session={session} activeId="s_settings" title={title}>
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
    </SellerShell>
  );
}
