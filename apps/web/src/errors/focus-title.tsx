'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** The page's h1, focused on load so a screen reader starts at what went wrong. */
export function FocusTitle({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}
