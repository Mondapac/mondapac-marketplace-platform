'use client';

import { useEffect, type ReactNode } from 'react';
import { useStore } from './store-context.tsx';

/**
 * The page behind the overlays. While Browse products or the search view is open the page is
 * inert (Tab stays in the overlay) and does not scroll; the search view, a phone and tablet
 * layout, closes when the screen grows to the desktop layout.
 */
export function PageFrame({ children }: { readonly children: ReactNode }) {
  const { browseOpen, searchOpen, setSearchOpen } = useStore();
  const overlay = browseOpen || searchOpen;

  useEffect(() => {
    if (!overlay) return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before;
    };
  }, [overlay]);

  useEffect(() => {
    if (!searchOpen || typeof window.matchMedia !== 'function') return;
    const desktop = window.matchMedia('(min-width: 900px)');
    const close = () => {
      if (desktop.matches) setSearchOpen(false);
    };
    close();
    desktop.addEventListener('change', close);
    return () => desktop.removeEventListener('change', close);
  }, [searchOpen, setSearchOpen]);

  return (
    <div className="frame" inert={overlay}>
      {children}
    </div>
  );
}
