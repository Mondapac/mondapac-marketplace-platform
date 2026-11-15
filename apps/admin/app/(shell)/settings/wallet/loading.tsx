import { SettingsLoading } from '../../../../src/settings/settings-loading.tsx';

/** Shown while the page loads: its form skeleton, card by card. */
export default function Loading() {
  return (
    <SettingsLoading
      titleKey="wallet.settings.title"
      sections={[{ fields: 2 }, { fields: 2 }, { fields: 2, description: true }]}
    />
  );
}
