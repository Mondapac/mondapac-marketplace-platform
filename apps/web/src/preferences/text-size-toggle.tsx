'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { TEXT_SIZE_COOKIE, savePreference, type TextSize } from './preferences.ts';

/** Large or Small text. Untouched, the size follows the screen (Large from 900px). */
export function TextSizeToggle({ initial }: { readonly initial: TextSize }) {
  const t = useTranslations('footer');
  const [size, setSize] = useState<TextSize>(initial);
  // The automatic size depends on the screen, known only after the first render.
  const [auto, setAuto] = useState<'large' | 'small' | null>(null);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(min-width: 900px)');
    const update = () => setAuto(query.matches ? 'large' : 'small');
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const choose = (value: 'large' | 'small') => {
    setSize(value);
    savePreference(TEXT_SIZE_COOKIE, 'textSize', value);
  };
  const pressed = (value: 'large' | 'small') =>
    size === value || (size === 'auto' && auto === value);
  return (
    <div className="tsz" role="group" aria-label={t('text-size')}>
      <span aria-hidden="true">{t('text-size')}</span>
      <button type="button" aria-pressed={pressed('large')} onClick={() => choose('large')}>
        {t('large')}
      </button>
      <button type="button" aria-pressed={pressed('small')} onClick={() => choose('small')}>
        {t('small')}
      </button>
    </div>
  );
}
