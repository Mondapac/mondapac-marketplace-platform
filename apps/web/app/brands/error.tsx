'use client';

import { useTranslations } from 'next-intl';
import { Icon } from '../../src/icons/icon.tsx';

/** A brands read failed: the card with Try again (nothing was changed). */
export default function BrandsError({ reset }: { readonly reset: () => void }) {
  const t = useTranslations('brands');
  return (
    <div className="br">
      <h1 className="sr-only">{t('title')}</h1>
      <div className="shop-empty" role="alert">
        <Icon name="info" />
        <h2>{t('error-title')}</h2>
        <p>{t('error-body')}</p>
        <button className="btn" type="button" onClick={reset}>
          {t('try-again')}
        </button>
      </div>
    </div>
  );
}
