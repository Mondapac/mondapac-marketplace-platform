'use client';

import { useTranslations } from 'next-intl';
import { SearchMessage } from '../../src/search/search-message.tsx';

/** The category's product read failed: the results error card with Try again (nothing changed). */
export default function CategoryError({ reset }: { readonly reset: () => void }) {
  const t = useTranslations('search-results');
  const route = useTranslations('route');
  return (
    <div className="sr">
      <h1>{route('error-title')}</h1>
      <SearchMessage icon="warn" title={t('error-title')} body={t('error-body')} live="alert">
        <button className="btn" type="button" onClick={reset}>
          {t('retry')}
        </button>
      </SearchMessage>
    </div>
  );
}
