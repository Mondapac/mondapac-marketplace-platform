import { LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { PayoutAccountView } from '../../../../src/payout/payout-account.tsx';
import { PAYOUT_MANAGE_PERMISSION } from '../../../../src/payout/types.ts';
import { loadPayoutPage } from '../../../../src/server/payout-page.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payout.title') };
}

export default async function PayoutAccountPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations();
  const page = await loadPayoutPage();
  if (page.kind === 'unavailable') {
    return <LoadError message={t('payout.error.load')} retryLabel={t('load.retry')} />;
  }
  if (page.kind === 'no-access') {
    return (
      <SettingsShell session={page.session} linkId="payout-account" title={t('payout.title')}>
        <NoAccess
          title={t('payout.no-access.title')}
          body={t('payout.no-access.body')}
          backHref="/settings"
          backLabel={t('settings.sub.back')}
        />
      </SettingsShell>
    );
  }
  const { stripe } = await searchParams;
  return (
    <SettingsShell session={page.session} linkId="payout-account" title={t('payout.title')}>
      <h1 className="mb-6 text-2xl font-semibold">{t('payout.title')}</h1>
      <PayoutAccountView
        initial={page.account}
        csrfToken={page.session.csrfToken}
        canManage={page.session.permissionKeys.includes(PAYOUT_MANAGE_PERMISSION)}
        back={stripe === 'return' || stripe === 'refresh' ? stripe : null}
      />
    </SettingsShell>
  );
}
