'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useHelpTab } from '../help/help-context.tsx';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  /** A longer explanation of the tab, as a pointer hint. */
  readonly title?: string;
  /** A link tab (a page of its own). Without it the tab is a button and calls `onSelect`. */
  readonly href?: string;
  /** `critical` draws the label in the danger colour (an Overdue count); the text still says it. */
  readonly tone?: 'critical';
  /** The tab's name in the Help text, when it is not its label (a count in the label, say). While this tab is active the Help panel shows that tab's part. */
  readonly help?: string;
}

export interface TabsProps {
  /** Name of the tab row landmark. */
  readonly label: string;
  readonly items: readonly TabItem[];
  readonly activeId: string;
  /** Button tabs only: the tab the user picked. */
  readonly onSelect?: (id: string) => void;
  /**
   * Button tabs that switch one panel on the same page: the ARIA tabs pattern (tablist, tab with
   * aria-selected and aria-controls, arrow keys, Home and End). The panel takes this id, the
   * `tabpanel` role and `aria-labelledby={tabIdOf(panelId, activeId)}`.
   */
  readonly panelId?: string;
}

/** The id of one tab of a `panelId` tab row, for the panel's aria-labelledby. */
export const tabIdOf = (panelId: string, id: string): string => `${panelId}-tab-${id}`;

const BASE =
  'flex min-h-12 min-w-11 shrink-0 items-center justify-center whitespace-nowrap border-b-2 px-1 focus-visible:outline-2 focus-visible:outline-focus';
const ACTIVE = `${BASE} border-accent font-medium text-fg`;
const IDLE = `${BASE} border-transparent text-fg-muted hover:text-fg`;

/**
 * The one tab row of both panels. It stays one line and scrolls sideways when the tabs do not
 * fit; a fade on the cut edge shows there is more, and the current tab is scrolled into view.
 * A link tab marks the current page with aria-current; a button tab is a toggle (aria-pressed).
 */
export function Tabs({ label, items, activeId, onSelect, panelId }: TabsProps) {
  // A div (tablist) or a nav: one ref type serves both.
  const row = useRef<HTMLDivElement>(null);
  const aria = panelId !== undefined && items.every((item) => item.href === undefined);
  useHelpTab(items.find((item) => item.id === activeId)?.help);

  // Arrow keys move between tabs (and select, as the panel is on the same page); Home and End
  // go to the first and last.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!aria || panelId === undefined) return;
    const index = items.findIndex((item) => item.id === activeId);
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = (forward: boolean) => (forward !== rtl ? 1 : -1);
    let next: number;
    if (event.key === 'ArrowRight') next = index + step(true);
    else if (event.key === 'ArrowLeft') next = index + step(false);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    const target = items[(next + items.length) % items.length];
    if (target === undefined) return;
    onSelect?.(target.id);
    document.getElementById(tabIdOf(panelId, target.id))?.focus();
  };
  const [fade, setFade] = useState({ start: false, end: false, rtl: false });

  useEffect(() => {
    const element = row.current;
    if (element === null) return;
    const update = () => {
      // scrollLeft is negative in a right-to-left page, so compare magnitudes.
      const left = Math.abs(element.scrollLeft);
      const rest = element.scrollWidth - element.clientWidth - left;
      setFade({
        start: left > 1,
        end: rest > 1,
        rtl: getComputedStyle(element).direction === 'rtl',
      });
    };
    // Older engines (and jsdom) lack these; the row still scrolls without them.
    const current = element.querySelector<HTMLElement>(
      '[aria-current="page"], [aria-pressed="true"], [aria-selected="true"]',
    );
    if (typeof current?.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [activeId, items.length]);

  const mask =
    fade.start || fade.end
      ? `linear-gradient(to ${fade.rtl ? 'left' : 'right'}, ${fade.start ? 'transparent, black 2.5rem' : 'black'}, ${fade.end ? 'black calc(100% - 2.5rem), transparent' : 'black'})`
      : undefined;

  const rowClass =
    'flex gap-4 overflow-x-auto sm:gap-6 border-b border-line [scrollbar-width:none]';
  const style = mask === undefined ? undefined : { maskImage: mask, WebkitMaskImage: mask };

  if (aria && panelId !== undefined) {
    return (
      <div
        ref={row}
        role="tablist"
        aria-label={label}
        style={style}
        className={rowClass}
        onKeyDown={onKeyDown}
      >
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              id={tabIdOf(panelId, item.id)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect?.(item.id)}
              className={active ? ACTIVE : IDLE}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <nav ref={row} aria-label={label} style={style} className={rowClass}>
      {items.map((item) => {
        const active = item.id === activeId;
        const className =
          item.tone === 'critical'
            ? `${BASE} text-critical-fg ${active ? 'border-accent font-medium' : 'border-transparent'}`
            : active
              ? ACTIVE
              : IDLE;
        return item.href === undefined ? (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            {...(item.title === undefined ? {} : { title: item.title })}
            onClick={() => onSelect?.(item.id)}
            className={className}
          >
            {item.label}
          </button>
        ) : (
          <a
            key={item.id}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            {...(item.title === undefined ? {} : { title: item.title })}
            className={className}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
