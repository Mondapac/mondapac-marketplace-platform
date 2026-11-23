'use client';

import { useId, useRef, type ReactNode } from 'react';
import { Icon } from '../icon/icon.tsx';
import { useModal } from './dialog.tsx';

export interface SidePanelProps {
  readonly open: boolean;
  /** Escape, the ✕ button and a click on the scrim. */
  readonly onClose: () => void;
  readonly title: string;
  /** A short line under the title (whose record the panel shows). */
  readonly description?: ReactNode;
  /** The ✕ button's name: "Close". */
  readonly closeLabel: string;
  readonly children: ReactNode;
}

const CLOSE =
  'flex size-(--mp-size-control) shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus';

/**
 * A wide panel from the inline-end edge for reading a list beside its record (a customer's
 * activity): a modal native `<dialog>`, so the browser traps focus and closes on Escape, and focus
 * returns to the button that opened it. Full screen on phones. The header stays in view while the
 * body scrolls. Menus and panels opened inside it render inside it (`portalHostOf`).
 */
export function SidePanel({
  open,
  onClose,
  title,
  description,
  closeLabel,
  children,
}: SidePanelProps) {
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
        if (event.target === ref.current) onClose();
      }}
      className="m-0 ms-auto h-dvh max-h-none w-full max-w-none overflow-hidden bg-transparent p-0 text-start text-fg backdrop:bg-scrim backdrop:backdrop-blur-sm motion-reduce:backdrop:backdrop-blur-none lg:w-[min(64rem,calc(100vw-4rem))]"
    >
      {open ? (
        <div className="flex h-full flex-col border-line bg-surface shadow-(--mp-shadow-elevation-floating) lg:border-s">
          <div className="flex items-start gap-2 border-b border-line px-4 py-3 sm:px-6">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-lg font-semibold">
                {title}
              </h2>
              {description === undefined ? null : (
                <p className="mt-1 text-sm text-fg-muted wrap-anywhere">{description}</p>
              )}
            </div>
            <button type="button" aria-label={closeLabel} onClick={onClose} className={CLOSE}>
              <Icon name="x" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}
