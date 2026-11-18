'use client';

import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { AlertState, Severity } from './types.ts';

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  s1: 'critical',
  s2: 'attention',
  s3: 'info',
  s4: 'neutral',
};

/** The severity as a labelled chip: the text carries it, the colour only repeats it. */
export function SeverityBadge({ severity }: { readonly severity: Severity }) {
  const t = useTranslations('security-centre.severity');
  return <Badge tone={SEVERITY_TONE[severity]}>{t(severity)}</Badge>;
}

/** The state: neutral while open (red stays for S1 only, Reza S1), blue acknowledged, green resolved. */
export function StateBadge({ state }: { readonly state: AlertState }) {
  const t = useTranslations('security-centre.state');
  const tone: BadgeTone =
    state === 'resolved' ? 'success' : state === 'acknowledged' ? 'info' : 'neutral';
  return <Badge tone={tone}>{t(state)}</Badge>;
}

/** "8 min ago" from an instant and the page's clock. */
export function useAgo() {
  const t = useTranslations('security-centre.ago');
  return (iso: string, now: number): string => {
    const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
    if (minutes < 1) return t('now');
    if (minutes < 60) return t('minutes', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('hours', { count: hours });
    return t('days', { count: Math.floor(hours / 24) });
  };
}

/** The page's clock: one tick a minute, so timers and "ago" lines move without a request. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Calls `tick` every `ms` while the tab is visible, and once when it becomes visible again. The
 * caller's work never moves focus or resets the page (Reza M10); it only replaces data in place.
 */
export function usePoll(tick: () => void, ms: number): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(() => latest.current(), ms);
    };
    const stop = () => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        latest.current();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms]);
}
