import { getTranslations } from 'next-intl/server';
import { SettingsForm } from '../../../../src/wallet/settings-form.tsx';
import { SETTINGS_MANAGE, SETTINGS_VIEW } from '../../../../src/wallet/types.ts';
import { WalletPage } from '../../../../src/wallet/wallet-page.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('wallet.settings.title') };
}

export default async function WalletSwitchPage() {
  const t = await getTranslations();
  return (
    <WalletPage
      activeId="settings"
      settingsLinkId="wallet"
      title={t('wallet.settings.title')}
      intro={t('wallet.settings.intro')}
      anyOf={[SETTINGS_VIEW]}
      stepUpNote
      body={(session, keys) => (
        <SettingsForm canManage={keys.has(SETTINGS_MANAGE)} csrfToken={session.csrfToken} />
      )}
    />
  );
}
