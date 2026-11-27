import { SettingsLoading } from '../../../../../../src/settings/settings-loading.tsx';

/** Shown while the review loads: the values card's skeleton. */
export default function Loading() {
  return <SettingsLoading titleKey="certification.review.title" sections={[{ fields: 5 }]} />;
}
