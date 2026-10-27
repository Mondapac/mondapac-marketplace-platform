'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';
import { under } from '../shell/breakpoints.ts';

/**
 * A product page section that is a native <details> disclosure on a phone (under 700px, a 44px
 * summary with a chevron) and an always-open heading from 700px. It renders open, so without
 * JavaScript, or if hydration fails, the content is there on every screen; once running, the
 * browser closes it on a phone and keeps it open (and not toggleable) on a wider screen.
 */
export function Collapsible({
  title,
  level,
  children,
}: {
  readonly title: string;
  readonly level: 'h2' | 'h3';
  readonly children: ReactNode;
}) {
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(under('tablet'));
    const update = () => {
      element.open = !query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const Heading = level;
  return (
    <details
      className="acc"
      ref={box}
      open
      onToggle={(event) => {
        // From 700px the section is a heading: it cannot stay closed.
        if (
          !event.currentTarget.open &&
          typeof window.matchMedia === 'function' &&
          !window.matchMedia(under('tablet')).matches
        )
          event.currentTarget.open = true;
      }}
    >
      <summary className="acc-sum">
        <Heading>{title}</Heading>
        <Icon name="chevr" />
      </summary>
      <div className="acc-panel">{children}</div>
    </details>
  );
}
