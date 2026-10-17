import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { PayoutAccountView } from '../../../src/payout/payout-account.tsx';
import { PAYOUT_MANAGE_PERMISSION } from '../../../src/payout/types.ts';
import { loadPayoutPage } from '../../../src/server/payout-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { SettingsHeader } from '../../../src/settings/settings-header.tsx';

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
      <SellerShell session={page.session} activeId="s_settings" title={t('settings.tab.payout')}>
        <SettingsHeader active="payout" permissionKeys={page.session.permissionKeys} t={t} />
        <h2 className="mb-2 text-lg font-semibold">{t('payout.no-access.title')}</h2>
        <p className="text-fg-muted">{t('payout.no-access.body')}</p>
      </SellerShell>
    );
  }
  const { stripe } = await searchParams;
  return (
    <SellerShell session={page.session} activeId="s_settings" title={t('settings.tab.payout')}>
      <SettingsHeader active="payout" permissionKeys={page.session.permissionKeys} t={t} />
      <PayoutAccountView
        initial={page.account}
        csrfToken={page.session.csrfToken}
        canManage={page.session.permissionKeys.includes(PAYOUT_MANAGE_PERMISSION)}
        back={stripe === 'return' || stripe === 'refresh' ? stripe : null}
      />
    </SellerShell>
  );
}
