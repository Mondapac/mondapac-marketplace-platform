'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../form/button.tsx';
import { Dialog } from '../overlay/dialog.tsx';

/** What the leave message tells the reader: how many changes are unsaved and on which page. */
export interface LeaveInfo {
  readonly count: number;
  readonly page: string;
}

export interface LeaveLabels {
  readonly title: string;
  /** "You have 2 unsaved changes on Delivery rules. If you leave now, they are lost." */
  readonly message: string | ((info: LeaveInfo) => string);
  /** Closes the dialog and keeps the page (the secondary button, focused). */
  readonly stay: string;
  readonly leave: string;
}

export interface ClickInfo {
  readonly button: number;
  readonly modified: boolean;
  readonly href: string;
  readonly target: string;
  readonly download: boolean;
}

/**
 * True when a click on a link leaves the page inside the app: a plain left click, same origin,
 * another path or query, same window. External links, new tabs, downloads and a jump to an
 * anchor on this page are left alone (the browser's own prompt covers a full unload).
 */
export function leavesPage(click: ClickInfo, here: URL): boolean {
  if (click.button !== 0 || click.modified || click.download) return false;
  if (click.target !== '' && click.target !== '_self') return false;
  let to: URL;
  try {
    to = new URL(click.href, here);
  } catch {
    return false;
  }
  if (to.origin !== here.origin) return false;
  return to.pathname !== here.pathname || to.search !== here.search;
}

/**
 * Warns before a page with unsaved changes is left. While `dirty`: the browser's own prompt on a
 * reload, close or typed address, and, for a click on an in-app link, a "Leave without saving?"
 * dialog (Stay, which has focus, or Leave). Render the returned `dialog` once in the page. Leaving by the browser's
 * back button is covered by the browser prompt only.
 */
export function useUnsavedChangesGuard(
  dirty: boolean,
  labels: LeaveLabels,
  info: LeaveInfo = { count: 0, page: '' },
): { readonly dialog: ReactNode } {
  const [target, setTarget] = useState<HTMLAnchorElement | null>(null);
  // Set while the confirmed click runs, so the guard lets it through; and, once confirmed, so the
  // browser does not ask a second time when the page unloads.
  const bypass = useRef(false);
  const confirmed = useRef(false);
  // Stay is the safe choice, so it takes focus (it is the first button; Leave is the primary one at the end).
  const stay = useRef<HTMLButtonElement>(null);

  // A layout effect, not a passive one: the guard must follow `dirty` in the same commit. With a
  // passive effect the old listeners outlive the commit that made the page clean (a save), so a
  // check right after the "Saved." toast could still see the guard.
  useLayoutEffect(() => {
    if (!dirty) return;
    confirmed.current = false;
    const onUnload = (event: BeforeUnloadEvent) => {
      if (confirmed.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onClick = (event: MouseEvent) => {
      if (bypass.current || !(event.target instanceof Element)) return;
      const anchor = event.target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const info: ClickInfo = {
        button: event.button,
        modified: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        href: anchor.href,
        target: anchor.target,
        download: anchor.hasAttribute('download'),
      };
      if (!leavesPage(info, new URL(window.location.href))) return;
      // Capture phase: the router's own handler never sees this click.
      event.preventDefault();
      event.stopPropagation();
      setTarget(anchor);
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  function leave() {
    const anchor = target;
    setTarget(null);
    if (anchor === null) return;
    confirmed.current = true;
    bypass.current = true;
    try {
      anchor.click();
    } finally {
      bypass.current = false;
    }
  }

  const dialog = (
    <Dialog
      open={target !== null}
      title={labels.title}
      onClose={() => setTarget(null)}
      initialFocus={stay}
      actions={
        <>
          <Button ref={stay} variant="secondary" onClick={() => setTarget(null)}>
            {labels.stay}
          </Button>
          <Button onClick={leave}>{labels.leave}</Button>
        </>
      }
    >
      {typeof labels.message === 'function' ? labels.message(info) : labels.message}
    </Dialog>
  );
  return { dialog };
}
