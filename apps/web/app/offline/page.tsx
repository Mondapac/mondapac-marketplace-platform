import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../src/seo/metadata.ts';
import { OfflinePage } from '../../src/errors/offline-page.tsx';

export async function generateMetadata() {
  const [t, description] = await Promise.all([
    getTranslations('errors'),
    seoDescription('offline'),
  ]);
  return pageMetadata({ name: t('offline-title'), description, path: '/offline', noindex: true });
}

/** The service worker's fallback for a page that is not saved (public/sw.js saves it, anonymous, with its static files; nothing else is saved). */
export default function OfflineRoute() {
  return <OfflinePage />;
}
