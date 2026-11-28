import { SettingsLoading } from '../../../../../../src/settings/settings-loading.tsx';

/** Shown while the certificate loads: the details card's skeleton. */
export default function Loading() {
  return <SettingsLoading titleKey="certification.seller.title" sections={[{ fields: 4 }]} />;
}
