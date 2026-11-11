'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/** A navigation that renders sooner than this shows no bar at all, so fast ones do not flash. */
export const PROGRESS_DELAY_MS = 150;
/** A navigation that never renders (the request was dropped) stops showing the bar after this. */
export const PROGRESS_GIVE_UP_MS = 15_000;

type Phase = 'idle' | 'waiting' | 'shown';

/**
 * The same-origin page a click on this link goes to, or null when the click is not a navigation
 * the router will run: a modified or non-primary click, a link that opens elsewhere or downloads,
 * a link marked `data-no-progress` (one that opens a panel instead), another origin, or the same
 * address (a change of hash alone included). Whether the click was cancelled says nothing here:
 * the router's own links cancel every click to navigate softly.
 */
export function navigationTarget(event: MouseEvent, here: URL): URL | null {
  if (event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const start = event.target instanceof Element ? event.target : null;
  const link = start?.closest('a[href]');
  if (!(link instanceof HTMLAnchorElement)) return null;
  const target = link.getAttribute('target');
  if (
    (target !== null && target !== '' && target !== '_self') ||
    link.hasAttribute('download') ||
    link.hasAttribute('data-no-progress')
  ) {
    return null;
  }
  let to: URL;
  try {
    to = new URL(link.href, here);
  } catch {
    return null;
  }
  if (to.origin !== here.origin) return null;
  if (to.pathname === here.pathname && to.search === here.search) return null;
  return to;
}

/**
 * A thin bar along the top of the page while a soft navigation is on its way (SEO package 5,
 * follow-up 2): the product and store routes have no loading boundary, because their 404 must be
 * decided before any HTML, so without it a tap on a card gives no sign until the page appears.
 * It starts on a click on a same-origin link, shows only after {@link PROGRESS_DELAY_MS}, and ends
 * when the new route renders. Screen readers hear "Loading" politely; with reduced motion the bar
 * is a still line instead of a moving one. Built in-house, no package.
 */
export function NavigationProgress() {
  const t = useTranslations('route');
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? '';
  const [phase, setPhase] = useState<Phase>('idle');
  const [reduced, setReduced] = useState(false);
  const timers = useRef<{ show?: number; giveUp?: number }>({});

  const clearTimers = () => {
    window.clearTimeout(timers.current.show);
    window.clearTimeout(timers.current.giveUp);
    timers.current = {};
  };

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    setReduced(query.matches);
    const change = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (navigationTarget(event, new URL(window.location.href)) === null) return;
      clearTimers();
      setPhase('waiting');
      timers.current.show = window.setTimeout(() => setPhase('shown'), PROGRESS_DELAY_MS);
      timers.current.giveUp = window.setTimeout(() => {
        clearTimers();
        setPhase('idle');
      }, PROGRESS_GIVE_UP_MS);
    };
    // Capture on window: before React's handlers on the document, which may stop the event.
    window.addEventListener('click', onClick, { capture: true });
    return () => {
      window.removeEventListener('click', onClick, { capture: true });
      clearTimers();
    };
  }, []);

  // The new route has rendered: the bar goes away (or never shows, when it was fast).
  useEffect(() => {
    clearTimers();
    setPhase('idle');
  }, [pathname, search]);

  const shown = phase === 'shown';
  return (
    <>
      {shown ? (
        <div
          className="nav-progress"
          data-motion={reduced ? 'reduced' : 'full'}
          data-testid="nav-progress"
          aria-hidden="true"
        >
          <div className="nav-progress-bar" />
        </div>
      ) : null}
      <div className="sr-only" role="status" aria-live="polite">
        {shown ? t('loading') : ''}
      </div>
    </>
  );
}
