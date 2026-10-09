'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** A disabled item stays visible; `reason` says why and is read with it. */
  readonly disabled?: boolean;
  readonly reason?: string;
  readonly tone?: 'default' | 'critical';
  readonly onSelect: () => void;
}

export interface MenuProps {
  /** Accessible name of the trigger, e.g. "Actions for Ada". */
  readonly label: string;
  readonly items: readonly MenuItem[];
}

/** A button that opens a menu of actions (WAI-ARIA menu button: arrows, Home, End, Escape). */
export function Menu({ label, items }: MenuProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const focusItem = (index: number) => {
    const nodes = list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (nodes === undefined || nodes.length === 0) return;
    nodes[(index + nodes.length) % nodes.length]?.focus();
  };

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

  return (
    <div className="relative inline-block">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-(--mp-size-control) w-(--mp-size-control) items-center justify-center rounded-md border border-line-control bg-surface text-fg hover:bg-muted"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="absolute end-0 z-10 mt-1 w-64 rounded-md border border-line bg-surface py-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-disabled={item.disabled === true ? true : undefined}
              tabIndex={-1}
              onClick={() => {
                if (item.disabled === true) return;
                setOpen(false);
                item.onSelect();
                trigger.current?.focus();
              }}
              className={[
                'block w-full px-4 py-2 text-start text-sm',
                item.disabled === true
                  ? 'cursor-not-allowed text-fg-muted'
                  : item.tone === 'critical'
                    ? 'text-critical-fg hover:bg-muted'
                    : 'text-fg hover:bg-muted',
              ].join(' ')}
            >
              {item.label}
              {item.disabled === true && item.reason !== undefined ? (
                <span className="mt-0.5 block text-xs font-normal">{item.reason}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
