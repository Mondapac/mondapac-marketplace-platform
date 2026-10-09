import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';
import { loadSetupPage } from '../../../../src/server/setup-page.ts';
import { ReviewSubmit } from '../../../../src/setup/review-submit.tsx';

export async function generateMetadata() {
  const t = await getTranslations('sellers');
  return { title: `${t('submit.title')} – ${t('page.title-suffix')}` };
}

export default async function ReviewPage() {
  const page = await loadSetupPage();
  const t = await getTranslations();
  if (page.kind !== 'ok') {
    return <p className="p-6 text-fg-muted">{t('sellers.page.unavailable')}</p>;
  }
  return (
    <SellerShell session={page.session} activeId="s_setup" title={t('nav.setup')}>
      <ReviewSubmit
        file={page.file}
        descriptors={page.descriptors}
        csrfToken={page.session.csrfToken}
      />
    </SellerShell>
  );
}
