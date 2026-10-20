import { getTranslations } from 'next-intl/server';
import { OfflinePage } from '../../src/errors/offline-page.tsx';

export async function generateMetadata() {
  const [t, store] = await Promise.all([getTranslations('errors'), getTranslations('store')]);
  return { title: `${t('offline-title')} | ${store('title')}`, robots: { index: false } };
}

/** The service worker's fallback for a page that is not saved (the caching list waits, PWA level). */
export default function OfflineRoute() {
  return <OfflinePage />;
}
