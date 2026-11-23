import { LoadError, SettingsPage, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { PayoutAccountView } from '../../../../src/payout/payout-account.tsx';
import { PAYOUT_MANAGE_PERMISSION } from '../../../../src/payout/types.ts';
import { loadPayoutPage } from '../../../../src/server/payout-page.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payout.title') };
}

/**
 * Payout account, under Accounting in the menu (menu design v2, 15 Nov 2026). It used to be a
 * Settings page; /settings/payout-account and /payout-account (where Stripe sends the seller
 * back) redirect here with their query.
 */
export default async function PayoutAccountPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations();
  const title = t('payout.title');
  const page = await loadPayoutPage();
  if (page.kind === 'unavailable') {
    // Without a session the shell cannot be drawn: the plain error is all there is.
    if (page.session === undefined)
      return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
    // Only the data failed: keep the shell and the page title.
    return (
      <SellerShell session={page.session} activeId="s_payout" title={title}>
        <SettingsPage title={title}>
          <LoadError
            title={t('settings.load-error.title', { page: title })}
            message={t('settings.load-error.body')}
            retryLabel={t('load.retry')}
            className="w-full"
          />
        </SettingsPage>
      </SellerShell>
    );
  }
  if (page.kind === 'no-access') {
    return (
      <SellerShell session={page.session} activeId="s_payout" title={title}>
        <PageHeader title={t('payout.no-access.title')} className="mb-2" />
        <p className="text-fg-muted">{t('payout.no-access.body')}</p>
      </SellerShell>
    );
  }
  const { stripe } = await searchParams;
  return (
    <SellerShell session={page.session} activeId="s_payout" title={title}>
      <PayoutAccountView
        initial={page.account}
        csrfToken={page.session.csrfToken}
        canManage={page.session.permissionKeys.includes(PAYOUT_MANAGE_PERMISSION)}
        back={stripe === 'return' || stripe === 'refresh' ? stripe : null}
      />
    </SellerShell>
  );
}
