import { getTranslations } from 'next-intl/server';
import { PageRoute } from '../../../../../src/content/pages/page-route.tsx';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('pages.editor.page-title') };
}

/** One page: the Content tab. `page` is the page's id, or the key of a system page. */
export default async function PageEditorPage({
  params,
}: {
  readonly params: Promise<{ readonly page: string }>;
}) {
  const { page } = await params;
  return PageRoute({ page, tab: 'content' });
}
