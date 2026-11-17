'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { usePoll } from './parts.tsx';
import { BADGE_POLL_MS, type Summary } from './types.ts';

/**
 * The top-bar badge (design v3, F4): the number of live critical alerts, read every 60 s while the
 * tab is visible. It shows nothing at zero or when the read fails, and links to the alerts list
 * (the summary names no alert). Colours are the soft critical pair, which keeps its contrast in
 * the dark theme (Reza M8); the label says what the link opens (M9).
 */
export function CriticalAlertsBadge() {
  const t = useTranslations('security-centre.badge');
  const [count, setCount] = useState(0);
  const read = useCallback(async () => {
    const answer = await callApi<Summary>('GET', 'security/admin/summary');
    if (answer.ok) setCount(answer.body.live.s1);
  }, []);
  useEffect(() => {
    void read();
  }, [read]);
  usePoll(() => void read(), BADGE_POLL_MS);
  if (count < 1) return null;
  return (
    <a
      href="/security/alerts"
      aria-label={t('label', { count })}
      className="inline-flex min-h-(--mp-size-control) items-center gap-1 rounded-full border border-critical-fg/30 bg-critical-bg px-3 text-sm font-semibold text-critical-fg hover:underline"
    >
      <span aria-hidden="true">{t('text', { count })}</span>
    </a>
  );
}
