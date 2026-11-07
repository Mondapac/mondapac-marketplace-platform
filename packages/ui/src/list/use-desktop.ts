'use client';

import { useSyncExternalStore } from 'react';

/** The width from which a list is a table and its filter and sort are popovers. */
export const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const snapshot = (): boolean =>
  typeof window.matchMedia !== 'function' ? true : window.matchMedia(DESKTOP_QUERY).matches;

/**
 * True from 1024 px, where the lists are tables. A runtime without `matchMedia` and the server
 * render count as desktop; a phone corrects it on the first client render.
 */
export function useDesktop(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
