'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import { useRetry } from './use-retry.ts';

/**
 * The banner over an already open page while the connection is lost (approved design errors-a-teal v1).
 * Meanwhile the cart cannot change and checkout is blocked (the store's `online`); when the
 * connection is back the page is read again, so prices and stock are current.
 */
export function OfflineBanner() {
  const t = useTranslations('errors');
  const { online } = useStore();
  const router = useRouter();
  const path = usePathname();
  const refresh = useCallback(() => router.refresh(), [router]);
  const { checking, stillOffline, retry } = useRetry(refresh);
  const wasOnline = useRef(online);

  useEffect(() => {
    if (online && !wasOnline.current) refresh();
    wasOnline.current = online;
  }, [online, refresh]);

  // The offline page says the same in full.
  if (online || path === '/offline') return null;
  return (
    <div className="er-ban" role="status">
      <Icon name="wifi-off" />
      <div>
        <b>{t('offline-title')}</b>
        {t('offline-banner')}
        {stillOffline && !checking ? <span className="er-st2">{t('still-offline')}</span> : null}
      </div>
      <button
        className="btn ghost"
        type="button"
        aria-disabled={checking || undefined}
        onClick={() => {
          if (!checking) void retry();
        }}
      >
        {checking ? t('checking') : t('retry')}
      </button>
    </div>
  );
}
