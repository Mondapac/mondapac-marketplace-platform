import { SettingsLoading } from '../../../../src/settings/settings-loading.tsx';

/** Shown while the list loads: skeleton rows, no spinner (design 5.2). */
export default function Loading() {
  return <SettingsLoading titleKey="certification.seller.title" sections={[{ fields: 4 }]} />;
}
