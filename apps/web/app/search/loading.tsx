import { getTranslations } from 'next-intl/server';
import { ResultsLoading } from '../../src/catalog/results.tsx';

export default async function Loading() {
  const t = await getTranslations('route');
  return <ResultsLoading label={t('loading')} />;
}
