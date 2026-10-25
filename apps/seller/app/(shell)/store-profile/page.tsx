import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { loadStoreProfilePage } from '../../../src/server/store-profile-page.ts';
import { StoreProfile } from '../../../src/store-profile/store-profile.tsx';
import { STORE_PROFILE_EDIT_PERMISSION } from '../../../src/store-profile/types.ts';

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
      <SellerShell
        session={page.session}
        activeId="s_store_profile"
        title={t('store-profile.title')}
      >
        <h1 className="mb-6 text-2xl font-semibold">{t('store-profile.title')}</h1>
        <h2 className="mb-2 text-lg font-semibold">{t('catalog.no-access.title')}</h2>
        <p className="text-fg-muted">{t('catalog.no-access.body')}</p>
      </SellerShell>
    );
  }
  return (
    <SellerShell session={page.session} activeId="s_store_profile" title={t('store-profile.title')}>
      <h1 className="mb-6 text-2xl font-semibold">{t('store-profile.title')}</h1>
      <StoreProfile
        initial={page.view}
        csrfToken={page.session.csrfToken}
        canEdit={page.session.permissionKeys.includes(STORE_PROFILE_EDIT_PERMISSION)}
      />
    </SellerShell>
  );
}
