import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { SettingsNoAccess } from '../../../../src/settings/settings-no-access.tsx';
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
        <SettingsNoAccess
          permissionKeys={page.session.permissionKeys}
          title={t('store-profile.no-access.title')}
          body={t('store-profile.no-access.body')}
          labels={{ settings: t('settings.sub.back'), home: t('settings.back-home') }}
        />
      </SettingsShell>
    );
  }
  return (
    <SettingsShell session={page.session} linkId="store-profile" title={t('store-profile.title')}>
      <StoreProfile
        initial={page.view}
        claimTerms={page.claimTerms}
        csrfToken={page.session.csrfToken}
        canEdit={page.session.permissionKeys.includes(STORE_PROFILE_EDIT_PERMISSION)}
      />
    </SettingsShell>
  );
}
