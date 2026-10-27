'use client';

import { useEffect } from 'react';

/** Where registration is allowed: a production build, on https or on localhost, with the API. */
export function mayRegister(env: {
  readonly production: boolean;
  readonly protocol: string;
  readonly hostname: string;
  readonly supported: boolean;
}): boolean {
  if (!env.production || !env.supported) return false;
  const localhost = env.hostname === 'localhost' || env.hostname === '127.0.0.1';
  return env.protocol === 'https:' || localhost;
}

/**
 * Registers /sw.js (the offline page and static files; see public/sw.js). The build id in the
 * query makes each deploy a new script URL, so the browser installs the new worker and its caches.
 * TODO(pwa-follow-up): a custom install prompt (beforeinstallprompt) is a later package; the
 * browser's native install behaviour is used until then.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
    if (
      !mayRegister({
        production: process.env.NODE_ENV === 'production',
        protocol: window.location.protocol,
        hostname: window.location.hostname,
        supported,
      })
    )
      return;
    const version = encodeURIComponent(process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev');
    navigator.serviceWorker.register(`/sw.js?v=${version}`, { scope: '/' }).catch(() => {
      // No worker: the site works as before, only without the offline page.
    });
  }, []);
  return null;
}
