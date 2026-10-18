'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

export interface Chip {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

/** The filter chips of a results page; on phones the row scrolls and starts at the chosen chip. */
export function FilterChips({
  label,
  chips,
}: {
  readonly label: string;
  readonly chips: readonly Chip[];
}) {
  const row = useRef<HTMLElement>(null);

  useEffect(() => {
    const nav = row.current;
    const chosen = nav?.querySelector<HTMLElement>('[aria-current]');
    if (!nav || !chosen || nav.scrollWidth <= nav.clientWidth) return;
    const offset = chosen.getBoundingClientRect().left - nav.getBoundingClientRect().left;
    nav.scrollLeft += offset - (nav.clientWidth - chosen.offsetWidth) / 2;
  }, [chips]);

  if (chips.length === 0) return null;
  return (
    <nav className="fchips" aria-label={label} ref={row}>
      {chips.map((chip) => (
        <Link
          key={chip.href}
          href={chip.href}
          aria-current={chip.current ? 'page' : undefined}
          scroll={false}
        >
          {chip.label}
        </Link>
      ))}
    </nav>
  );
}
