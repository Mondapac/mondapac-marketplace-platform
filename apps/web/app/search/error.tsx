'use client';

import { useTranslations } from 'next-intl';
import { SearchMessage } from '../../src/search/search-message.tsx';

/** The search read failed: the design's error card with Try again (nothing was changed). */
export default function SearchError({ reset }: { readonly reset: () => void }) {
  const t = useTranslations('search-results');
  return (
    <div className="sr">
      <h1>{t('error-heading')}</h1>
      <SearchMessage icon="info" title={t('error-title')} body={t('error-body')} alert>
        <button className="btn" type="button" onClick={reset}>
          {t('retry')}
        </button>
      </SearchMessage>
    </div>
  );
}
