'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { TABBAR_ATTRIBUTE } from './tabbar-autohide.tsx';
import { useKeyboardOpen } from './use-keyboard.ts';

/**
 * The sticky bottom of the phone and tablet layout: the cookie bar above the tab bar. The page's
 * own action bar (the product's buy bar, the cart's checkout bar) sticks above the dock using
 * `--sf-dock-height`, and the assistant launcher lifts above both, so no layer lands on another.
 * The dock writes its height (0 when it is empty or hidden) to `--sf-dock-height` on <html>, and
 * hides the tab bar while the on-screen keyboard is open (see use-keyboard.ts).
 */
export function Dock({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useKeyboardOpen();

  useEffect(() => {
    const dock = ref.current;
    if (!dock) return;
    const root = document.documentElement;
    const set = () => {
      root.style.setProperty('--sf-dock-height', `${dock.offsetHeight}px`);
      // The home-indicator inset belongs to the bottom-most layer: the dock's own content carries
      // it (tab bar, cookie bar), so a bar above an occupied dock adds none; above an empty one it does.
      // While the tab bar is slid away (product pages) the dock only looks empty: the action bar is
      // then the bottom-most layer and takes the inset, once.
      const covered = dock.offsetHeight > 0 && root.getAttribute(TABBAR_ATTRIBUTE) !== 'hidden';
      root.style.setProperty(
        '--sf-dock-inset',
        covered ? '0px' : 'env(safe-area-inset-bottom, 0px)',
      );
    };
    set();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(set) : null;
    observer?.observe(dock);
    const attribute = new MutationObserver(set);
    attribute.observe(root, { attributes: true, attributeFilter: [TABBAR_ATTRIBUTE] });
    return () => {
      observer?.disconnect();
      attribute.disconnect();
      root.style.removeProperty('--sf-dock-height');
      root.style.removeProperty('--sf-dock-inset');
    };
  }, []);

  return (
    <div className="dock" ref={ref}>
      {children}
    </div>
  );
}
