import { getTranslations } from 'next-intl/server';
import { PageRoute } from '../../../../../../src/content/pages/page-route.tsx';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('pages.settings.page-title') };
}

/** One page: the Settings tab. */
export default async function PageSettingsPage({
  params,
}: {
  readonly params: Promise<{ readonly page: string }>;
}) {
  const { page } = await params;
  return PageRoute({ page, tab: 'settings' });
}
