import { SettingsLoading } from '../../../../src/settings/settings-loading.tsx';

/** Shown while the page loads: its form skeleton, card by card. */
export default function Loading() {
  return (
    <SettingsLoading
      titleKey="ship-to-retention.title"
      sections={[{ fields: 2, description: true }]}
    />
  );
}
