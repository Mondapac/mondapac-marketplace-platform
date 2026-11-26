import { SettingsLoading } from '../../../../src/settings/settings-loading.tsx';

/** Shown while the page loads: its form skeleton, card by card. */
export default function Loading() {
  return (
    <SettingsLoading
      titleKey="ai-gateway.title"
      sections={[{ fields: 1 }, { fields: 3 }, { fields: 8 }, { fields: 2 }]}
    />
  );
}
