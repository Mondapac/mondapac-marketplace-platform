'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect } from 'react';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import { FocusTitle } from './focus-title.tsx';
import { useRetry } from './use-retry.ts';

/**
 * The offline page (approved design errors-a-teal v1): what a service worker serves when a page
 * is not saved. Try again reloads once the marketplace answers, and so does the connection coming
 * back by itself. What is saved for offline use is not decided yet (PWA level).
 */
export function OfflinePage() {
  const t = useTranslations('errors');
  const { online } = useStore();
  const reload = useCallback(() => window.location.reload(), []);
  const { checking, stillOffline, retry } = useRetry(reload);

  useEffect(() => {
    const back = () => void retry();
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, [retry]);

  return (
    <div className="er">
      <div className="er-box" role="alert">
        <div className="er-ic" aria-hidden="true">
          <Icon name="wifi-off" />
        </div>
        <FocusTitle>{t('offline-title')}</FocusTitle>
        <p>{t('offline-message')}</p>
        <div className="er-act">
          <button
            className="btn"
            type="button"
            aria-disabled={checking || undefined}
            onClick={() => {
              if (!checking) void retry();
            }}
          >
            {checking ? t('checking') : t('retry')}
          </button>
        </div>
        <p className="er-st2" role="status" aria-live="polite">
          {stillOffline && !online ? t('still-offline') : null}
        </p>
      </div>
    </div>
  );
}
