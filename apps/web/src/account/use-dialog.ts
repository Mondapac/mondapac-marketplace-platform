'use client';

import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], select, textarea';

/**
 * The keyboard of a modal panel while it is open: focus moves into it (`first`, else its first
 * control), Tab and Shift+Tab stay inside it, Esc closes it, and focus goes back to the control
 * that opened it when it closes.
 */
export function useDialog(
  open: boolean,
  close: () => void,
  panel: RefObject<HTMLElement | null>,
  first?: (root: HTMLElement) => HTMLElement | null,
) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const root = panel.current;
    const start =
      (root && first ? first(root) : null) ?? root?.querySelector<HTMLElement>(FOCUSABLE);
    start?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.getClientRects().length > 0 || el === document.activeElement,
      );
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && at <= 0) {
        event.preventDefault();
        items[items.length - 1]!.focus();
      } else if (!event.shiftKey && at === items.length - 1) {
        event.preventDefault();
        items[0]!.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
    // `close` and `first` are read when the panel opens.
  }, [open, panel]);
}
