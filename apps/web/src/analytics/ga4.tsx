'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';
import { Suspense, useEffect, useRef, useState } from 'react';
import { reportedPath } from './page-path.ts';

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
  useEffect(() => {
    gtag('event', 'page_view', { ...location(pathname, search), page_title: document.title });
  }, [pathname, search]);
  const here = useRef({ pathname, search });
  here.current = { pathname, search };
  // Core Web Vitals in the field: LCP, INP and CLS, only while this component is mounted, which
  // is only with consent.
  useReportWebVitals((metric: VitalsMetric) => {
    if (!VITALS.has(metric.name)) return;
    gtag('event', metric.name, {
      ...location(here.current.pathname, here.current.search),
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
      if (wasEnabled.current) window.location.reload();
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
