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
import { Icon, type IconName } from '../icon/icon.tsx';

/** Gap between the menu and its trigger, and the least space kept to the viewport edge. */
const GAP = 4;
const EDGE = 8;

export interface ActionMenuItem {
  readonly id: string;
  readonly label: string;
  /** A second line under the label (Figma MenuItem "Show description"). */
  readonly description?: string;
  readonly icon?: IconName;
  /** `critical` is the destructive item (Delete…). */
  readonly tone?: 'default' | 'critical';
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export interface ActionMenuLink {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface ActionMenuProps {
  /** The button's text, e.g. "Bulk action"; also the menu's accessible name. */
  readonly label: string;
  /** The line at the top of the open menu, e.g. "3 products selected"; the button never shows it. */
  readonly title?: string;
  readonly items: readonly ActionMenuItem[];
  /** Plain links under the items, after a divider (Select all in this filter, Clear selection). */
  readonly links?: readonly ActionMenuLink[];
  /** The button is disabled, as the Figma Disabled state (a page action with nothing to act on). */
  readonly disabled?: boolean;
  /** Pointer hint on the button, such as why it is disabled. */
  readonly hint?: string;
}

/**
 * A Secondary button with a trailing chevron that opens a menu of page actions under it (Figma
 * "Bulk action"): a heading line, items with an icon and an optional description, and, after a
 * divider, links. The menu is drawn in a portal with fixed coordinates, so a table box with
 * overflow never clips it; it lines up with the button's end edge, stays inside the viewport and
 * opens upwards when there is no room. WAI-ARIA menu button: arrows, Home, End, Escape; Tab closes.
 */
export function ActionMenu({
  label,
  title,
  items,
  links = [],
  disabled = false,
  hint,
}: ActionMenuProps) {
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
    const width = Math.min(node.offsetWidth, window.innerWidth - 2 * EDGE);
    const left = getComputedStyle(button).direction === 'rtl' ? anchor.left : anchor.right - width;
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const openUp = node.scrollHeight > below && above > below;
    setPlace({
      left: Math.min(Math.max(left, EDGE), window.innerWidth - width - EDGE),
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

  const focusItem = (index: number) => {
    const nodes = list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (nodes === undefined || nodes.length === 0) return;
    nodes[(index + nodes.length) % nodes.length]?.focus();
  };

  // The button disables while the menu is open only if the caller says so: close with it.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) focusItem(0);
  }, [open]);

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
    const nodes = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') focusItem(at + 1);
    else if (event.key === 'ArrowUp') focusItem(at - 1);
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(nodes.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      if (event.key === 'Escape') trigger.current?.focus();
      return;
    } else return;
    event.preventDefault();
  };

  const choose = (run: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    run();
  };

  return (
    <div className="inline-block">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        title={hint}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open && !disabled) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-(--mp-size-control) items-center justify-center gap-2 rounded-md border border-line-control bg-surface px-4 font-medium text-fg hover:bg-muted disabled:cursor-not-allowed disabled:text-fg-muted disabled:hover:bg-surface"
      >
        {label}
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
              className="z-50 w-75 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-line bg-surface p-2 shadow-lg"
            >
              {title === undefined ? null : (
                <p
                  role="presentation"
                  className="px-3 pb-1 pt-2 text-xs font-semibold text-fg-muted"
                >
                  {title}
                </p>
              )}
              <div role="group">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    aria-disabled={item.disabled === true ? true : undefined}
                    tabIndex={-1}
                    onClick={() => {
                      if (item.disabled === true) return;
                      choose(item.onSelect);
                    }}
                    className={[
                      // At least one control high: 48 px touch targets on phones (panels IA 4).
                      'flex min-h-(--mp-size-control) w-full items-center gap-3 rounded-md px-3 py-2 text-start text-sm',
                      item.disabled === true
                        ? 'cursor-not-allowed text-fg-muted'
                        : item.tone === 'critical'
                          ? 'text-critical-fg hover:bg-critical-bg'
                          : 'text-fg hover:bg-muted',
                    ].join(' ')}
                  >
                    {item.icon === undefined ? null : (
                      <Icon
                        name={item.icon}
                        className={item.tone === 'critical' ? 'shrink-0' : 'shrink-0 text-icon'}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">{item.label}</span>
                      {item.description === undefined ? null : (
                        <span className="block break-words text-xs font-normal text-fg-muted">
                          {item.description}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
              {links.length === 0 ? null : (
                <div role="group" className="mt-2 border-t border-line-row pt-2">
                  {links.map((link) => (
                    <button
                      key={link.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      onClick={() => choose(link.onSelect)}
                      className="flex min-h-(--mp-size-control-sm) w-full items-center rounded-md px-3 py-2 text-start text-sm font-medium text-link hover:bg-muted"
                    >
                      <span className="min-w-0 break-words">{link.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
