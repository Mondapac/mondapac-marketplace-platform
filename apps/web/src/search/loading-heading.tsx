'use client';

import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';

/** The loading state's heading: the words being searched for, read from the address. */
export function LoadingHeading() {
  const t = useTranslations('search-results');
  const query = (useSearchParams()?.get('q') ?? '').trim().replace(/\s+/gu, ' ');
  return (
    <h1>{query ? t.rich('heading', { query, q: (chunks) => <q>{chunks}</q> }) : t('title')}</h1>
  );
}
