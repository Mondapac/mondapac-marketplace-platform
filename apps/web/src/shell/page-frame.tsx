'use client';

import { useEffect, type ReactNode } from 'react';
import { useStore } from './store-context.tsx';
import { from } from './breakpoints.ts';
import { useCheckoutFocus } from './checkout-focus.tsx';

/**
 * The page behind the overlays. While Browse products, the search view, a listing's filters
 * drawer, the cart drawer, the log-in dialog, the account menu, the Deliver to modal or a page's modal dialog is open the page is inert (Tab stays in the
 * overlay) and does not scroll; the search view, a phone and tablet layout, closes when the
 * screen grows to the desktop layout. Offline, the cart controls are dimmed (`data-offline`).
 */
export function PageFrame({ children }: { readonly children: ReactNode }) {
  const {
    browseOpen,
    searchOpen,
    setSearchOpen,
    filtersOpen,
    dialogOpen,
    cartOpen,
    loginOpen,
    accountOpen,
    online,
    deliverOpen,
  } = useStore();
  const focus = useCheckoutFocus();
  const overlay =
    browseOpen ||
    searchOpen ||
    filtersOpen ||
    dialogOpen ||
    cartOpen ||
    loginOpen ||
    accountOpen ||
    deliverOpen;

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
    const desktop = window.matchMedia(from('desktop'));
    const close = () => {
      if (desktop.matches) setSearchOpen(false);
    };
    close();
    desktop.addEventListener('change', close);
    return () => desktop.removeEventListener('change', close);
  }, [searchOpen, setSearchOpen]);

  return (
    <div
      className="frame"
      inert={overlay}
      data-offline={online ? undefined : ''}
      data-focus={focus ? 'checkout' : undefined}
    >
      {children}
    </div>
  );
}
