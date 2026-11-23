'use client';

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../form/button.tsx';
import { Icon } from '../icon/icon.tsx';
import { Dialog, useModal } from '../overlay/dialog.tsx';

export interface SettingsDrawerLabels {
  /** The ✕ button: "Close". */
  readonly close: string;
  /** "Cancel". */
  readonly cancel: string;
  /** The exact verb of the primary button: "Add location", "Save location". */
  readonly submit: string;
  /** The ask before a close that would lose input: "Discard changes?". */
  readonly discardTitle: string;
  /** "You have unsaved input. If you close now, it is lost." */
  readonly discardMessage: string;
  /** Keeps the drawer open (focused). */
  readonly keepEditing: string;
  readonly discard: string;
}

export interface SettingsDrawerProps {
  readonly open: boolean;
  /** Called when the drawer is closed for good (Cancel, ✕, Escape or the scrim, after any discard ask). */
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: ReactNode;
  /** The form fields; they scroll under the fixed header. */
  readonly children: ReactNode;
  /** The error summary and any banner: shown at the top of the body. */
  readonly notice?: ReactNode;
  /** Called by the primary button and by Enter in a field; not called while `pending`. */
  readonly onSubmit: () => void;
  readonly pending?: boolean;
  /** True when the form holds input that is not saved: closing asks first. */
  readonly dirty?: boolean;
  readonly labels: SettingsDrawerLabels;
}

const ICON_BUTTON =
  'flex size-(--mp-size-control) shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus';

/**
 * The add/edit drawer of the settings pages (settings upgrade D3, T2): a modal panel from the
 * inline-end edge for a record form of up to about ten fields (longer forms are their own page
 * with a SaveBar, confirmations stay a Dialog). It is a native `<dialog>`, so the browser traps
 * focus and closes on Escape, and focus returns to the button that opened it. The header and the
 * footer (Cancel, then the primary verb) stay in view while the body scrolls. A close with unsaved
 * input asks first.
 */
export function SettingsDrawer({
  open,
  onClose,
  title,
  description,
  children,
  notice,
  onSubmit,
  pending = false,
  dirty = false,
  labels,
}: SettingsDrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [asking, setAsking] = useState(false);
  useModal(ref, open);

  function requestClose() {
    if (pending) return;
    if (dirty) setAsking(true);
    else onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!pending) onSubmit();
  }

  return (
    <>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        data-density="touch"
        onCancel={(event) => {
          event.preventDefault();
          requestClose();
        }}
        onClick={(event) => {
          if (event.target === ref.current) requestClose();
        }}
        className="m-0 ms-auto h-dvh max-h-none w-full max-w-none overflow-hidden bg-transparent p-0 text-start text-fg backdrop:bg-scrim backdrop:backdrop-blur-sm motion-reduce:backdrop:backdrop-blur-none sm:w-(--mp-size-sheet) xl:w-(--mp-size-sheet-wide)"
      >
        {open ? (
          <form
            onSubmit={submit}
            noValidate
            className="flex h-full flex-col border-line bg-surface shadow-(--mp-shadow-elevation-floating) sm:border-s"
          >
            <div className="flex items-center gap-2 px-4 pt-3 sm:px-6">
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="truncate text-lg font-semibold">
                  {title}
                </h2>
                {description === undefined ? null : (
                  <p className="mt-1 text-sm text-fg-muted">{description}</p>
                )}
              </div>
              <button
                type="button"
                aria-label={labels.close}
                onClick={requestClose}
                className={ICON_BUTTON}
              >
                <Icon name="x" />
              </button>
            </div>
            <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-line px-4 py-4 sm:px-6">
              {notice ?? null}
              {children}
            </div>
            <div className="flex flex-col-reverse gap-3 border-t border-line bg-surface px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
              <Button variant="secondary" onClick={requestClose} disabled={pending}>
                {labels.cancel}
              </Button>
              <Button type="submit" loading={pending}>
                {labels.submit}
              </Button>
            </div>
          </form>
        ) : null}
      </dialog>
      <Dialog
        open={asking}
        title={labels.discardTitle}
        onClose={() => setAsking(false)}
        initialFocus={keep}
        actions={
          <>
            <Button ref={keep} variant="secondary" onClick={() => setAsking(false)}>
              {labels.keepEditing}
            </Button>
            <Button
              variant="destructive-solid"
              onClick={() => {
                setAsking(false);
                onClose();
              }}
            >
              {labels.discard}
            </Button>
          </>
        }
      >
        {labels.discardMessage}
      </Dialog>
    </>
  );
}
