import { LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { loadStoreProfilePage } from '../../../../src/server/store-profile-page.ts';
import { StoreProfile } from '../../../../src/store-profile/store-profile.tsx';
import { STORE_PROFILE_EDIT_PERMISSION } from '../../../../src/store-profile/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('store-profile.title') };
}

export default async function StoreProfilePage() {
  const t = await getTranslations();
  const page = await loadStoreProfilePage();
  if (page.kind === 'unavailable') {
    return (
      <LoadError message={t('store-profile.error.unavailable')} retryLabel={t('load.retry')} />
    );
  }
  if (page.kind === 'no-access') {
    return (
      <SettingsShell session={page.session} linkId="store-profile" title={t('store-profile.title')}>
        <NoAccess
          title={t('store-profile.no-access.title')}
          body={t('store-profile.no-access.body')}
          backHref="/settings"
          backLabel={t('settings.sub.back')}
        />
      </SettingsShell>
    );
  }
  return (
    <SettingsShell session={page.session} linkId="store-profile" title={t('store-profile.title')}>
      <h1 className="mb-6 text-2xl font-semibold">{t('store-profile.title')}</h1>
      <StoreProfile
        initial={page.view}
        csrfToken={page.session.csrfToken}
        canEdit={page.session.permissionKeys.includes(STORE_PROFILE_EDIT_PERMISSION)}
      />
    </SettingsShell>
  );
}
