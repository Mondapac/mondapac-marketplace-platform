import { SettingsLoading } from '../../../../src/settings/settings-loading.tsx';

/** Shown while the page loads: its form skeleton, card by card. */
export default function Loading() {
  return (
    <SettingsLoading
      titleKey="payout.title"
      subNav={false}
      sections={[{ fields: 3 }, { fields: 1 }]}
    />
  );
}
