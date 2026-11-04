'use client';

import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

/**
 * After the dialog is gone: while it is open the page is inert and cannot take focus. A dialog
 * that is still open by then (a development re-mount) keeps its focus.
 */
function giveFocusBack(element: HTMLElement | null, dialog: HTMLDialogElement | null): void {
  if (element === null) return;
  setTimeout(() => {
    if (element.isConnected && (dialog === null || !dialog.isConnected || !dialog.open)) {
      element.focus();
    }
  }, 0);
}

/**
 * Opens and closes a native `<dialog>` as a modal with `open`: the browser traps focus, makes the
 * rest of the page inert and closes on Escape, and focus returns to the opener. Shared by the
 * Dialog and the side sheets (the notifications drawer).
 *
 * A layout effect, so the element opens and closes in the same commit as `open` changes. A
 * passive effect runs a task later: the content is already gone while the element is still
 * open, so the page can paint an empty modal for a frame, and a test that waits for the next
 * state can still find the dialog open.
 */
export function useModal(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  initialFocus?: RefObject<HTMLElement | null>,
): void {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      // The browser focuses the first focusable element; a caller can name a safer one.
      initialFocus?.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [ref, open, initialFocus]);

  // Focus goes back to the opener when the dialog closes or its owner removes it from the page:
  // a dialog taken out of the DOM while open does not give focus back by itself.
  useLayoutEffect(() => {
    if (open) return;
    giveFocusBack(opener.current, ref.current);
  }, [ref, open]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => giveFocusBack(opener.current, dialog);
  }, [ref]);
}

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  /** Called on Escape, a click on the backdrop and the close button's own handler. */
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** The buttons, in reading order; the last is the primary one. */
  readonly actions: ReactNode;
  /** A short line under the buttons (why one is disabled); tie it to the button with aria-describedby. */
  readonly actionsNote?: ReactNode;
  /** The element that takes focus when the dialog opens (the safe choice of a destructive one). */
  readonly initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * A modal dialog on the native `<dialog>` element: the browser traps focus, makes the rest of
 * the page inert and closes on Escape. Focus returns to the opener when it closes.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
  actionsNote,
  initialFocus,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModal(ref, open, initialFocus);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Only the backdrop: a click on the dialog's own padding also targets the element.
        const box = ref.current?.getBoundingClientRect();
        if (
          event.target === ref.current &&
          box !== undefined &&
          (event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom)
        )
          onClose();
      }}
      // text-start: a dialog opened from a table's end-aligned Actions cell would inherit text-end.
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100%-2rem))] overflow-y-auto rounded-lg border border-line bg-surface p-4 text-start text-fg backdrop:bg-fg/40 sm:p-6"
    >
      {open ? (
        <>
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <div className="mt-2 text-fg-secondary">{children}</div>
          {/* Sticky: on a long form the buttons stay in view at the bottom of the dialog. */}
          <div className="sticky bottom-0 -mx-4 -mb-4 mt-6 border-t border-line bg-surface px-4 py-4 sm:-mx-6 sm:-mb-6 sm:px-6">
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
              {actions}
            </div>
            {actionsNote === undefined || actionsNote === null ? null : (
              <div className="mt-2 text-sm text-fg-muted sm:text-end">{actionsNote}</div>
            )}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
