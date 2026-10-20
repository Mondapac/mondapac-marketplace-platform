import { getTranslations } from 'next-intl/server';
import { LoadingHeading } from '../../src/search/loading-heading.tsx';
import { SearchLoading } from '../../src/search/search-page.tsx';

export default async function Loading() {
  const t = await getTranslations('search-results');
  return <SearchLoading heading={<LoadingHeading />} label={t('loading')} />;
}
