'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { under } from './breakpoints.ts';
import { INITIAL_SCROLL, nextTabBar } from './tabbar-scroll.ts';

/** The attribute on <html> while the tab bar is slid away (`data-tabbar="hidden"`). */
export const TABBAR_ATTRIBUTE = 'data-tabbar';
/** Set for a moment after each change, while the bar and the bars above it are moving. */
export const TABBAR_MOVING = 'data-tabbar-moving';
/** How long the move lasts (the CSS transition is 200ms). */
export const TABBAR_MOVE_MS = 260;

/** Product pages only; every other page keeps the tab bar. */
export function hidesTabBar(path: string | null | undefined): boolean {
  return typeof path === 'string' && /^\/p\/[^/]+\/?$/.test(path);
}

/**
 * On a product page on a phone the tab bar slides away while the buyer scrolls down and comes
 * back on the way up or at the top (rules in tabbar-scroll.ts). It does nothing for the cookie bar
 * (the bar stays while the cookie bar is open, so the stack never has a gap), the on-screen
 * keyboard, or a wider screen. CSS does the sliding with a transform, so nothing in the layout
 * moves; the attribute is removed when the page is left.
 */
export function TabBarAutoHide() {
  const path = usePathname();
  const active = hidesTabBar(path);
  useEffect(() => {
    if (!active || typeof window.matchMedia !== 'function') return;
    const root = document.documentElement;
    const phone = window.matchMedia(under('tablet'));
    let state = { ...INITIAL_SCROLL, anchor: window.scrollY };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (hidden: boolean) => {
      if ((root.getAttribute(TABBAR_ATTRIBUTE) === 'hidden') === hidden) return;
      if (hidden) root.setAttribute(TABBAR_ATTRIBUTE, 'hidden');
      else root.removeAttribute(TABBAR_ATTRIBUTE);
      root.setAttribute(TABBAR_MOVING, 'true');
      clearTimeout(timer);
      timer = setTimeout(() => root.removeAttribute(TABBAR_MOVING), TABBAR_MOVE_MS);
    };
    const onScroll = () => {
      if (!phone.matches) return apply(false);
      // The bar stays while the cookie bar is open.
      if (document.querySelector('.consent')) {
        state = { hidden: false, anchor: window.scrollY };
        return apply(false);
      }
      const max = root.scrollHeight - window.innerHeight;
      state = nextTabBar(state, window.scrollY, max);
      apply(state.hidden);
    };
    const reset = () => {
      state = { hidden: false, anchor: window.scrollY };
      apply(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    phone.addEventListener('change', reset);
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      phone.removeEventListener('change', reset);
      clearTimeout(timer);
      root.removeAttribute(TABBAR_ATTRIBUTE);
      root.removeAttribute(TABBAR_MOVING);
    };
  }, [active]);
  return null;
}
