'use client';

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
  if (addressOf(to) === addressOf(here)) return null;
  return to;
}

/** A page's address with no trailing slash and its query in a fixed order, to compare two. */
function addressOf(url: URL): string {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : url.pathname;
  const query = new URLSearchParams(url.search);
  query.sort();
  return `${path}?${query.toString()}`;
}

export interface NavigationProgressProps {
  /**
   * The rendered route (pathname and query). The app reads it from its router, so this package
   * stays free of Next.js; a change ends the bar.
   */
  readonly route: string;
  /**
   * Announced politely while the bar shows (the buyer site: "Loading"). Leave it out where the
   * page itself announces its loading state (the panels: one role="status" per page, on the
   * skeleton), so a screen reader hears it once.
   */
  readonly label?: string;
  /** The bar's track and fill. The default is the panels' 2 px accent line (styles.css). */
  readonly className?: string;
  readonly barClassName?: string;
}

/**
 * A thin bar along the top of the page while a soft navigation is on its way. Moved from the buyer
 * site (SEO package 5, follow-up 2) for panel loading L1; both panels and the buyer site use it.
 * Page navigations only: a save shows its spinner on the button, and background requests
 * (notification polling) never start it, because only a click on a same-origin link does.
 * A control that opens a panel must be a `<button>`, or a link marked `data-no-progress`: a link
 * whose click is cancelled would otherwise keep the bar up until {@link PROGRESS_GIVE_UP_MS}.
 * It shows only after {@link PROGRESS_DELAY_MS}, is indeterminate (no made-up percentage), and
 * ends when the new route renders. With reduced motion the bar is a still line. It works beside
 * the route's loading.tsx and skeletons and replaces neither.
 */
export function NavigationProgress({
  route,
  label,
  className = 'mp-nav-progress',
  barClassName = 'mp-nav-progress-bar',
}: NavigationProgressProps) {
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
  }, [route]);

  const shown = phase === 'shown';
  return (
    <>
      {shown ? (
        <div
          className={className}
          data-motion={reduced ? 'reduced' : 'full'}
          data-testid="nav-progress"
          aria-hidden="true"
        >
          <div className={barClassName} />
        </div>
      ) : null}
      {label === undefined ? null : (
        <div className="sr-only" role="status" aria-live="polite">
          {shown ? label : ''}
        </div>
      )}
    </>
  );
}
