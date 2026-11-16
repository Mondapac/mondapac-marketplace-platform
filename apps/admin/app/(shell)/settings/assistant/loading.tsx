import { SettingsLoading } from '../../../../src/settings/settings-loading.tsx';

/** Shown while the page loads: its form skeleton, card by card. */
export default function Loading() {
  return (
    <SettingsLoading
      titleKey="settings.assistant.title"
      sections={[
        { fields: 1 },
        { fields: 3 },
        { fields: 4 },
        { fields: 3 },
        { fields: 2, description: true },
        { fields: 2 },
      ]}
    />
  );
}
