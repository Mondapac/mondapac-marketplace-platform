import { SettingsLoading } from '../../../../src/settings/settings-loading.tsx';

/** Shown while the page loads: its form skeleton, card by card. */
export default function Loading() {
  return <SettingsLoading titleKey="tax.title" sections={[{ fields: 3, description: true }]} />;
}
