import { SettingsLoading } from '../../../../../src/settings/settings-loading.tsx';

/** Shown while the insights page loads. */
export default function Loading() {
  return (
    <SettingsLoading
      titleKey="settings.assistant.insights-title"
      sections={[{ fields: 2 }, { fields: 3 }]}
    />
  );
}
