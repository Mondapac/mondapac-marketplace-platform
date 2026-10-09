'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  /** Called on Escape, a click on the backdrop and the close button's own handler. */
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** The buttons, in reading order; the last is the primary one. */
  readonly actions: ReactNode;
}

/**
 * A modal dialog on the native `<dialog>` element: the browser traps focus, makes the rest of
 * the page inert and closes on Escape. Focus returns to the opener when it closes.
 */
export function Dialog({ open, title, onClose, children, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-lg border border-line bg-surface p-6 text-fg backdrop:bg-fg/40"
    >
      {open ? (
        <>
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <div className="mt-2 text-fg-secondary">{children}</div>
          <div className="mt-6 flex flex-wrap justify-end gap-3">{actions}</div>
        </>
      ) : null}
    </dialog>
  );
}
