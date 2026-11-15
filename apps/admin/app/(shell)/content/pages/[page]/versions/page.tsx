import { getTranslations } from 'next-intl/server';
import { PageRoute } from '../../../../../../src/content/pages/page-route.tsx';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('pages.versions.page-title') };
}

/** One page: the Versions tab. */
export default async function PageVersionsPage({
  params,
}: {
  readonly params: Promise<{ readonly page: string }>;
}) {
  const { page } = await params;
  return PageRoute({ page, tab: 'versions' });
}
