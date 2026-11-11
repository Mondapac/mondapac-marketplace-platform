'use client';

import { useId, useRef, type ReactNode } from 'react';
import { IconButton } from '../form/icon-button.tsx';
import { useModal } from './dialog.tsx';

export interface BottomSheetProps {
  readonly open: boolean;
  readonly title: string;
  /** Accessible name of the close button ("Close"). */
  readonly closeLabel: string;
  /** Escape, a tap on the dimmed page and the close button. */
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * A panel that rises from the bottom edge of a phone (Figma "Phone" frames: filter and sort open
 * in a sheet). Built on the native `<dialog>` like the Dialog: the browser traps focus, makes the
 * rest of the page inert and closes on Escape, and focus returns to the opener. It holds at most
 * 85% of the screen and scrolls inside.
 */
export function BottomSheet({ open, title, closeLabel, onClose, children }: BottomSheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModal(ref, open);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The backdrop: the panel inside fills the dialog, so only a tap outside targets it.
        if (event.target === ref.current) onClose();
      }}
      className="m-0 mt-auto max-h-none w-full max-w-none bg-transparent p-0 text-start text-fg backdrop:bg-scrim"
    >
      {open ? (
        <div className="flex max-h-[85dvh] flex-col rounded-t-xl border-t border-line bg-surface shadow-(--mp-shadow-elevation-floating)">
          <div className="flex items-center justify-between gap-2 px-4 pt-3">
            <h2 id={titleId} className="min-w-0 truncate text-lg font-semibold">
              {title}
            </h2>
            <IconButton icon="x" label={closeLabel} onClick={onClose} />
          </div>
          <div className="min-h-0 overflow-y-auto px-4 pb-4 pt-2">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}
