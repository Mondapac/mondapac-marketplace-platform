'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';
import { Suspense, useEffect, useRef, useState } from 'react';
import { reportedPath, reportedReferrer, reportedTitle } from './page-path.ts';

// Google Analytics 4 with Consent Mode v2, basic mode (SEO package 7): the Google tag is not
// loaded at all until the buyer accepts analytics, so nothing is sent before a choice. Ads are
// never granted: there are none.

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

export const GA4_SCRIPT_ID = 'ga4-tag';
const VITALS = new Set(['LCP', 'INP', 'CLS']);

/** The part of a web-vitals metric that is sent (Next hands over the `web-vitals` library's object). */
interface VitalsMetric {
  readonly name: string;
  readonly value: number;
  readonly id: string;
  readonly delta: number;
  readonly rating: string;
}

/** `gtag()` of Google's snippet: the dataLayer takes the `arguments` object itself, not an array. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function gtag(..._command: unknown[]): void {
  const layer = (window.dataLayer ??= []);
  // eslint-disable-next-line prefer-rest-params
  layer.push(arguments);
}

/** Where the event says the page is: the path without a query on routes that may carry personal data. */
function location(pathname: string, search: string): Record<string, string> {
  const path = reportedPath(pathname, search);
  return { page_path: path, page_location: `${window.location.origin}${path}` };
}

function PageEvents() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = useRef({ pathname, search });
  here.current = { pathname, search };
  // The page reported before this one, and the referrer reported for the current page: the first
  // page view reads document.referrer, later ones the previous reported page. gtag would otherwise
  // send the raw referrer, query string included.
  const lastReported = useRef<string | null>(null);
  const cameFrom = useRef('');
  /**
   * Everything gtag would otherwise fill in from the browser: location, title and referrer, with
   * the query string and the page title cleaned on routes that may carry personal data. Every event
   * carries it, and `set` makes it the default for events the tag sends on its own.
   */
  const context = (): Record<string, string> => ({
    ...location(here.current.pathname, here.current.search),
    page_title: reportedTitle(here.current.pathname, document.title),
    page_referrer: cameFrom.current,
  });
  useEffect(() => {
    cameFrom.current =
      lastReported.current ?? reportedReferrer(document.referrer, window.location.origin);
    const where = context();
    gtag('set', {
      page_location: where.page_location,
      page_title: where.page_title,
      page_referrer: where.page_referrer,
    });
    gtag('event', 'page_view', where);
    lastReported.current = where.page_location ?? null;
  }, [pathname, search]);
  // Core Web Vitals in the field: LCP, INP and CLS, only while this component is mounted, which
  // is only with consent.
  useReportWebVitals((metric: VitalsMetric) => {
    if (!VITALS.has(metric.name)) return;
    gtag('event', metric.name, {
      ...context(),
      value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
      metric_id: metric.id,
      metric_value: metric.value,
      metric_delta: metric.delta,
      metric_rating: metric.rating,
      non_interaction: true,
    });
  });
  return null;
}

/**
 * The GA4 tag. `enabled` is the buyer's analytics consent as the server read it; the layout passes
 * it again after every save. Turning it off after it was on reloads the page once, because a
 * script that has loaded cannot be unloaded.
 */
export function Ga4({
  id,
  nonce,
  enabled,
}: {
  readonly id: string;
  readonly nonce: string | null;
  readonly enabled: boolean;
}) {
  const [ready, setReady] = useState(false);
  const wasEnabled = useRef(false);

  useEffect(() => {
    if (!enabled) {
      if (wasEnabled.current) {
        // The loaded tag stops measuring at once; the reload then removes it.
        gtag('consent', 'update', {
          analytics_storage: 'denied',
          ad_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied',
        });
        window.location.reload();
      }
      return;
    }
    wasEnabled.current = true;
    if (document.getElementById(GA4_SCRIPT_ID) === null) {
      // Everything denied first; then analytics is granted, as the buyer chose. The cookies are
      // host-only, so withdrawing consent can delete them (src/consent/save-consent.ts).
      gtag('consent', 'default', {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      });
      gtag('js', new Date());
      gtag('consent', 'update', {
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      });
      gtag('config', id, {
        send_page_view: false,
        cookie_domain: 'none',
        cookie_flags: 'SameSite=Lax;Secure',
      });
      const script = document.createElement('script');
      script.id = GA4_SCRIPT_ID;
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
      if (nonce !== null) script.setAttribute('nonce', nonce);
      document.head.appendChild(script);
    }
    setReady(true);
  }, [enabled, id, nonce]);

  if (!enabled || !ready) return null;
  return (
    <Suspense fallback={null}>
      <PageEvents />
    </Suspense>
  );
}
