'use client';

import { useEffect } from 'react';

/**
 * The phone home page's search field (buyer mobile plan, M3) sits under the header and folds
 * away on scroll down, leaving a search icon in the header; scrolling up, or a tap on the icon,
 * brings it back. The state is one attribute on <html> (`data-hsearch="collapsed"`), as the
 * keyboard's is, so the field and the header icon follow it with CSS alone.
 */
export const COLLAPSE_ATTRIBUTE = 'data-hsearch';

/** Scrolling less than this many pixels the other way does not flip the state (touch jitter). */
export const COLLAPSE_SLACK = 12;

export interface CollapseInput {
  readonly collapsed: boolean;
  /** The scroll position now and at the last change of state or direction. */
  readonly y: number;
  readonly anchor: number;
  /** The height of the field: collapsing starts once the page has scrolled past it. */
  readonly fieldHeight: number;
}

export interface CollapseResult {
  readonly collapsed: boolean;
  /** The position the next comparison starts from. */
  readonly anchor: number;
}

/** The next state for a scroll position; pure so it can be tested without a browser. */
export function nextCollapse({ collapsed, y, anchor, fieldHeight }: CollapseInput): CollapseResult {
  // At the top the field is always open (and rubber-band overscroll is not a scroll).
  if (y <= fieldHeight && !collapsed) return { collapsed: false, anchor: Math.max(0, y) };
  if (y <= 0) return { collapsed: false, anchor: 0 };
  if (!collapsed) {
    // Going down: the anchor follows upward moves so only a real downward run collapses.
    if (y - anchor >= COLLAPSE_SLACK) return { collapsed: true, anchor: y };
    return { collapsed: false, anchor: Math.min(anchor, y) };
  }
  if (anchor - y >= COLLAPSE_SLACK) return { collapsed: false, anchor: y };
  return { collapsed: true, anchor: Math.max(anchor, y) };
}

/**
 * Watches the scroll position and keeps `data-hsearch` on <html> in step. Put on the field; the
 * attribute is removed when the page changes. `fieldHeight` is read from the field when it is
 * given a ref, else the default.
 */
export function useSearchCollapse(fieldHeight = 56): void {
  useEffect(() => {
    const root = document.documentElement;
    let collapsed = false;
    let anchor = window.scrollY;
    const onScroll = () => {
      const next = nextCollapse({ collapsed, y: window.scrollY, anchor, fieldHeight });
      anchor = next.anchor;
      if (next.collapsed === collapsed) return;
      collapsed = next.collapsed;
      if (collapsed) root.setAttribute(COLLAPSE_ATTRIBUTE, 'collapsed');
      else root.removeAttribute(COLLAPSE_ATTRIBUTE);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      root.removeAttribute(COLLAPSE_ATTRIBUTE);
    };
  }, [fieldHeight]);
}
