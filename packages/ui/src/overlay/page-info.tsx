'use client';

import { useId } from 'react';
import { Popover } from './popover.tsx';

export interface PageInfoProps {
  /** The page's name; the button is announced as "About <page>" ("About this page" when left out, for a list whose title is in the top bar). */
  readonly page?: string;
  /** The page's static intro: its purpose or rule. Warnings, banners and live counts stay on the page. */
  readonly children: string;
  /** `sm` 288 px (default) or `md` 340 px for a long text. */
  readonly width?: 'sm' | 'md';
}

/**
 * The ⓘ beside a page title that holds the page's static intro. It opens on click or tap (never
 * hover); Escape or a click outside closes it. The text is also read by a screen reader from the
 * button's description without opening it. Put it right after the h1, or at the start of a
 * heading-less list's header row. Never put a warning, error or anything a user must see here.
 */
export function PageInfo({ page, children, width = 'sm' }: PageInfoProps) {
  const textId = useId();
  return (
    <>
      <span id={textId} className="sr-only">
        {children}
      </span>
      <Popover
        variant="icon"
        icon="info"
        label={page === undefined ? 'About this page' : `About ${page}`}
        width={width}
        describedBy={textId}
      >
        {() => <p className="max-h-30 overflow-y-auto text-sm text-fg-secondary">{children}</p>}
      </Popover>
    </>
  );
}
