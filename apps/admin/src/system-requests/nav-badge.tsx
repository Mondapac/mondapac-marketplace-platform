'use client';

import { useSetNavBadge } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { callApi } from '../api/client.ts';
import { CHANGED_EVENT } from './errors.ts';
import { BASE, type Badge } from './types.ts';

/** The `badgeSource` of the System requests menu item. */
export const BADGE_SOURCE = 'system-requests';

/** The count is read at most this often by the timer. */
const POLL_MS = 60_000;
/** A return to the tab refreshes the count, but not more often than this. */
const FOCUS_GAP_MS = 10_000;

/**
 * Keeps the menu badge of System requests fresh: when the shell loads, when the window gets
 * focus, after a decision on these pages and then every 60 seconds while the tab is visible. It
 * does nothing, and never calls the API, for an admin without the view permission. A failed read
 * clears the badge: the menu never shows an error.
 */
export function SystemRequestsNavBadge({ enabled }: { readonly enabled: boolean }) {
  const t = useTranslations('system-requests.badge');
  const setBadge = useSetNavBadge();
  // The words may change with a render; reading them through a ref keeps the timer in place.
  const words = useRef(t);
  words.current = t;

  useEffect(() => {
    if (!enabled) {
      setBadge(BADGE_SOURCE, null);
      return undefined;
    }
    let live = true;
    let last = 0;
    const refresh = async () => {
      last = Date.now();
      const result = await callApi<Badge>('GET', `${BASE}/requests-count`);
      if (!live) return;
      if (!result.ok || !Number.isFinite(result.body.needsMyReview)) {
        setBadge(BADGE_SOURCE, null);
        return;
      }
      const { needsMyReview, overdue } = result.body;
      setBadge(
        BADGE_SOURCE,
        needsMyReview > 0
          ? {
              count: needsMyReview,
              tone: overdue > 0 ? 'critical' : 'info',
              label: words.current('label', {
                waiting: needsMyReview,
                overdue: Math.max(0, overdue),
              }),
            }
          : null,
      );
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const onFocus = () => {
      if (Date.now() - last >= FOCUS_GAP_MS) void refresh();
    };
    const onChanged = () => void refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(CHANGED_EVENT, onChanged);
    };
  }, [enabled, setBadge]);

  return null;
}
