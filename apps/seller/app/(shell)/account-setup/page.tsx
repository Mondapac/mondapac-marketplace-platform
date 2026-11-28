import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import type { MyActivities } from '../../../src/setup/types.ts';
import { loadSetupPage } from '../../../src/server/setup-page.ts';
import { SetupHub } from '../../../src/setup/setup-hub.tsx';
import { CERTIFICATE_VIEW_PERMISSION } from '../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations('sellers');
  return { title: `${t('account.title')} – ${t('page.title-suffix')}` };
}

export default async function AccountSetupPage() {
  const [page, mine] = await Promise.all([
    loadSetupPage(),
    serverGet<MyActivities>('sellers/my-file/activities'),
  ]);
  const t = await getTranslations();
  if (page.kind !== 'ok') {
    return <LoadError message={t('sellers.page.unavailable')} retryLabel={t('load.retry')} />;
  }
  return (
    <SellerShell session={page.session} activeId="s_setup" title={t('sellers.account.title')}>
      <SetupHub
        file={page.file}
        csrfToken={page.session.csrfToken}
        activityChosen={
          mine.kind === 'ok' &&
          (mine.body.requested !== null || mine.body.assigned.mainActivityId !== null)
        }
        certificates={page.session.permissionKeys.includes(CERTIFICATE_VIEW_PERMISSION)}
      />
    </SellerShell>
  );
}
