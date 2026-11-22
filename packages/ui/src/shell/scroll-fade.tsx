'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Pixels of slack so a fractional scroll position at the very end still counts as the end. */
const EDGE = 2;

/**
 * A scrolling area that fades its content out at an edge while more lies beyond it: at the
 * bottom when there is more below, at the top once scrolled down. The fade is a CSS mask (see
 * `.mp-scroll-fade` in styles.css), so it follows the light and dark themes with no colour of
 * its own, never covers a link (clicks pass through), and does not animate, so reduced motion
 * needs nothing special. With no overflow nothing fades.
 */
export function ScrollFade({
  className = '',
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(false);
  const [bottom, setBottom] = useState(false);

  const measure = useCallback(() => {
    const el = box.current;
    if (el === null) return;
    setTop(el.scrollTop > EDGE);
    setBottom(el.scrollHeight - el.clientHeight - el.scrollTop > EDGE);
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    measure();
    // Groups opening or closing, the window resizing and the rail widening all change the overflow.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resize?.observe(el);
    const mutation = new MutationObserver(measure);
    mutation.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-expanded'],
    });
    window.addEventListener('resize', measure);
    return () => {
      resize?.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  return (
    <div
      ref={box}
      onScroll={measure}
      data-fade-top={top ? 'true' : undefined}
      data-fade-bottom={bottom ? 'true' : undefined}
      className={`mp-scroll-fade ${className}`}
    >
      {children}
    </div>
  );
}
