'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Badge } from '../form/badge.tsx';
import { Icon, type IconName } from '../icon/icon.tsx';
import { portalHostOf } from './portal-host.ts';

/** Gap between the menu and its trigger, and the least space kept to the viewport edge. */
const GAP = 4;
const EDGE = 8;
/** The page gutter on a phone: the full-width menu lines up with the content. */
const PHONE_EDGE = 16;

export interface LinkMenuItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon?: IconName;
  /** A second, smaller line under the label. */
  readonly description?: string;
  /** Shown after the label and read with it ("Sellers that need a look, 3"). Null: no number. */
  readonly count?: number | null;
  /** The page the admin is on: ticked and marked `aria-current="page"`. */
  readonly current?: boolean;
}

export interface LinkMenuProps {
  /** The button's text, e.g. "Queues"; also the menu's accessible name. */
  readonly label: string;
  readonly items: readonly LinkMenuItem[];
  /** An icon before the button's label. */
  readonly icon?: IconName;
  /**
   * A neutral number on the button, e.g. the sum of the queues' counts. Hidden when null or 0,
   * never drawn as "0". `accessibleName` is the button's whole accessible name when it shows.
   */
  readonly badge?: { readonly text: string; readonly accessibleName: string } | null;
}

/**
 * A button that opens a menu of real links (WAI-ARIA menu button: Enter, Space or ArrowDown open
 * it and focus the first item; arrows, Home and End move; Escape closes and returns focus; Tab and
 * a click outside close). Like `ActionMenu` the list is drawn in a portal with fixed coordinates;
 * on a phone it spans the viewport width. Items are anchors, so they open in a new tab and show
 * their address like any link.
 */
export function LinkMenu({ label, items, icon, badge = null }: LinkMenuProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [place, setPlace] = useState<CSSProperties | null>(null);

  const position = useCallback(() => {
    const button = trigger.current;
    const node = list.current;
    if (button === null || node === null) return;
    const anchor = button.getBoundingClientRect();
    const phone = window.innerWidth < 640;
    const width = phone ? window.innerWidth - 2 * PHONE_EDGE : Math.min(node.offsetWidth, 320);
    const left = getComputedStyle(button).direction === 'rtl' ? anchor.left : anchor.right - width;
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const openUp = node.scrollHeight > below && above > below;
    setPlace({
      left: phone ? PHONE_EDGE : Math.min(Math.max(left, EDGE), window.innerWidth - width - EDGE),
      ...(phone ? { width } : {}),
      maxHeight: Math.max(openUp ? above : below, 0),
      ...(openUp
        ? { bottom: window.innerHeight - anchor.top + GAP }
        : { top: anchor.bottom + GAP }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return undefined;
    }
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, position]);

  const nodes = () =>
    Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const focusItem = (index: number) => {
    const all = nodes();
    if (all.length === 0) return;
    all[(index + all.length) % all.length]?.focus();
  };

  // Focus waits for the placement: a hidden menu takes no focus.
  const placed = place !== null;
  useEffect(() => {
    if (open && placed) focusItem(0);
  }, [open, placed]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = nodes();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') focusItem(at + 1);
    else if (event.key === 'ArrowUp') focusItem(at - 1);
    else if (event.key === ' ' && at >= 0) all[at]?.click();
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(all.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      // The list sits at the end of the page: focus goes back to the button first, so Tab moves
      // on to the control after it.
      trigger.current?.focus();
      return;
    } else return;
    event.preventDefault();
  };

  return (
    <div className="inline-block">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        {...(badge === null ? {} : { 'aria-label': badge.accessibleName })}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-(--mp-size-control) items-center justify-center gap-2 rounded-md border border-line-control bg-surface px-4 font-medium text-fg hover:bg-muted"
      >
        {icon === undefined ? null : <Icon name={icon} className="text-icon" />}
        {label}
        {badge === null ? null : <Badge tone="neutral">{badge.text}</Badge>}
        <Icon name="chevron-down" className="text-icon" />
      </button>
      {open
        ? createPortal(
            <div
              ref={list}
              id={menuId}
              role="menu"
              aria-label={label}
              onKeyDown={onKeyDown}
              style={{
                position: 'fixed',
                ...place,
                visibility: place === null ? 'hidden' : 'visible',
              }}
              className="z-50 w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-line bg-surface p-2 shadow-lg"
            >
              {items.map((item) => (
                <a
                  key={item.id}
                  href={item.href}
                  role="menuitem"
                  tabIndex={-1}
                  // The name carries the count, so a screen reader hears "Sellers that need a look, 3".
                  {...(item.count === undefined || item.count === null
                    ? {}
                    : { 'aria-label': `${item.label}, ${item.count}` })}
                  {...(item.current === true ? { 'aria-current': 'page' as const } : {})}
                  className={`flex min-h-(--mp-size-control) w-full items-center gap-3 rounded-md px-3 py-2 text-start text-sm text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-focus ${item.current === true ? 'bg-muted' : ''}`}
                >
                  {item.icon === undefined ? null : (
                    <Icon name={item.icon} className="shrink-0 text-icon" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium">{item.label}</span>
                    {item.description === undefined ? null : (
                      <span className="block break-words text-xs font-normal text-fg-muted">
                        {item.description}
                      </span>
                    )}
                  </span>
                  {item.count === undefined || item.count === null ? null : (
                    <span aria-hidden="true" className="shrink-0">
                      <Badge tone="attention">{item.count}</Badge>
                    </span>
                  )}
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {item.current === true ? <Icon name="check" className="text-icon" /> : null}
                  </span>
                </a>
              ))}
            </div>,
            portalHostOf(trigger.current),
          )
        : null}
    </div>
  );
}
