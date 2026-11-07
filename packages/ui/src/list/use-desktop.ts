'use client';

import { useSyncExternalStore } from 'react';

/** The width from which a list is a table and its filter and sort are popovers. */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/** From 640 px, where a list footer has room for its full page number row. */
export const WIDE_QUERY = '(min-width: 640px)';

/** True while the media query matches; without `matchMedia` (and on the server) it counts as true. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => (typeof window.matchMedia !== 'function' ? true : window.matchMedia(query).matches),
    () => true,
  );
}

/**
 * True from 1024 px, where the lists are tables. A runtime without `matchMedia` and the server
 * render count as desktop; a phone corrects it on the first client render.
 */
export function useDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
