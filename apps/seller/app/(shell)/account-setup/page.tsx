import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { loadSetupPage } from '../../../src/server/setup-page.ts';
import { SetupHub } from '../../../src/setup/setup-hub.tsx';

export async function generateMetadata() {
  const t = await getTranslations('sellers');
  return { title: `${t('account.title')} – ${t('page.title-suffix')}` };
}

export default async function AccountSetupPage() {
  const page = await loadSetupPage();
  const t = await getTranslations();
  if (page.kind !== 'ok') {
    return <LoadError message={t('sellers.page.unavailable')} retryLabel={t('load.retry')} />;
  }
  return (
    <SellerShell session={page.session} activeId="s_setup" title={t('sellers.account.title')}>
      <SetupHub file={page.file} csrfToken={page.session.csrfToken} />
    </SellerShell>
  );
}
