import { LoadError, SettingsPage } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { PayoutAccountView } from '../../../../src/payout/payout-account.tsx';
import { PAYOUT_MANAGE_PERMISSION } from '../../../../src/payout/types.ts';
import { loadPayoutPage } from '../../../../src/server/payout-page.ts';
import { SettingsNoAccess } from '../../../../src/settings/settings-no-access.tsx';
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
    // Without a session the shell cannot be drawn: the plain error is all there is.
    if (page.session === undefined)
      return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
    // Only the data failed: keep the settings layout (sub-navigation, breadcrumb, page title).
    return (
      <SettingsShell session={page.session} linkId="payout-account" title={t('payout.title')}>
        <SettingsPage title={t('payout.title')}>
          <LoadError
            title={t('settings.load-error.title', { page: t('payout.title') })}
            message={t('settings.load-error.body')}
            retryLabel={t('load.retry')}
            className="w-full"
          />
        </SettingsPage>
      </SettingsShell>
    );
  }
  if (page.kind === 'no-access') {
    return (
      <SettingsShell session={page.session} linkId="payout-account" title={t('payout.title')}>
        <SettingsNoAccess
          pageTitle={t('payout.title')}
          permissionKeys={page.session.permissionKeys}
          title={t('payout.no-access.title')}
          body={t('payout.no-access.body')}
          labels={{ settings: t('settings.sub.back'), home: t('settings.back-home') }}
        />
      </SettingsShell>
    );
  }
  const { stripe } = await searchParams;
  return (
    <SettingsShell session={page.session} linkId="payout-account" title={t('payout.title')}>
      <PayoutAccountView
        initial={page.account}
        csrfToken={page.session.csrfToken}
        canManage={page.session.permissionKeys.includes(PAYOUT_MANAGE_PERMISSION)}
        back={stripe === 'return' || stripe === 'refresh' ? stripe : null}
      />
    </SettingsShell>
  );
}
