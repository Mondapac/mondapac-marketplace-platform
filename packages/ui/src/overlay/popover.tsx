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
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../icon/icon.tsx';

/** Gap between the panel and its trigger, and the least space kept to the viewport edge. */
const GAP = 4;
const EDGE = 8;

const WIDTH = { sm: 'w-72', md: 'w-85', lg: 'w-130' } as const;

export interface PopoverProps {
  /** Accessible name of the trigger and of the panel, e.g. "Sort". */
  readonly label: string;
  readonly icon: IconName;
  /** A small number on the trigger, such as the count of filters applied; hidden when 0. */
  readonly count?: number;
  /** `sm` 288 px, `md` 340 px, `lg` 520 px; never wider than the viewport. */
  readonly width?: keyof typeof WIDTH;
  /** The panel's content; `close` shuts the panel and returns focus to the trigger. */
  readonly children: (close: () => void) => ReactNode;
}

/**
 * An icon button that opens a panel of controls under it (Figma Popover: the filter, sort and
 * column panels of a list). The panel is drawn in a portal with fixed coordinates, so a table box
 * with overflow never clips it; it lines up with the trigger's start edge, stays inside the
 * viewport and scrolls when it is taller than the space left. Escape and a click outside close
 * it. Unlike a menu it holds fields, so Tab moves through them and focus starts on the panel.
 */
export function Popover({ label, icon, count = 0, width = 'md', children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [place, setPlace] = useState<CSSProperties | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  const position = useCallback(() => {
    const button = trigger.current;
    const node = panel.current;
    if (button === null || node === null) return;
    const anchor = button.getBoundingClientRect();
    const size = Math.min(node.offsetWidth, window.innerWidth - 2 * EDGE);
    const left = getComputedStyle(button).direction === 'rtl' ? anchor.right - size : anchor.left;
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const openUp = node.scrollHeight > below && above > below;
    setPlace({
      left: Math.min(Math.max(left, EDGE), window.innerWidth - size - EDGE),
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

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  return (
    <div className="inline-flex items-center gap-1">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={count > 0 ? `${label} (${count})` : label}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-(--mp-size-control) w-(--mp-size-control) items-center justify-center rounded-md border border-line-control bg-surface text-fg hover:bg-muted"
      >
        <Icon name={icon} />
      </button>
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="inline-flex min-w-5 items-center justify-center rounded-full bg-info-bg px-1.5 text-xs font-medium text-info-fg"
        >
          {count}
        </span>
      ) : null}
      {open
        ? createPortal(
            <div
              ref={panel}
              id={panelId}
              role="dialog"
              aria-label={label}
              tabIndex={-1}
              onKeyDown={onKeyDown}
              style={{
                position: 'fixed',
                ...place,
                visibility: place === null ? 'hidden' : 'visible',
              }}
              className={`z-50 ${WIDTH[width]} max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-line bg-surface p-4 shadow-lg focus:outline-none`}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
