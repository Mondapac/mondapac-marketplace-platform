import { SettingsLoading } from '../../../../src/settings/settings-loading.tsx';

/** Shown while the page loads: its form skeleton, card by card. */
export default function Loading() {
  return (
    <SettingsLoading
      titleKey="promotionsSettings.title"
      sections={[
        { fields: 1, description: true },
        { fields: 4, description: true },
        { fields: 3, description: true },
      ]}
    />
  );
}
