'use client';

import { useTranslations } from 'next-intl';
import { Icon } from '../../src/icons/icon.tsx';

/** The sellers read failed: the design's error card with Try again (nothing was changed). */
export default function SellersError({ reset }: { readonly reset: () => void }) {
  const t = useTranslations('sellers');
  return (
    <div className="sl">
      <h1 className="sr-only">{t('title')}</h1>
      <div className="sl-empty" role="alert">
        <Icon name="info" />
        <h2>{t('error-title')}</h2>
        <p>{t('error-body')}</p>
        <button className="btn" type="button" onClick={reset}>
          {t('retry')}
        </button>
      </div>
    </div>
  );
}
