'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The heading of a state reached without a page load. It takes focus when it appears so that
 * assistive technology announces the new state (identity ux 6). A step whose first field takes
 * focus instead (the two-step code step) passes `takeFocus={false}`.
 */
export function FocusHeading({
  children,
  takeFocus = true,
}: {
  readonly children: ReactNode;
  readonly takeFocus?: boolean;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (takeFocus) ref.current?.focus();
  }, [takeFocus]);
  return (
    <h2 ref={ref} tabIndex={-1} className="text-lg font-semibold text-fg outline-none">
      {children}
    </h2>
  );
}
