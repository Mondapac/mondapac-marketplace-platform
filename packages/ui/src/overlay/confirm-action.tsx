'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Banner } from '../form/banner.tsx';
import { Button } from '../form/button.tsx';
import { TextAreaField } from '../form/text-area-field.tsx';
import { TextField } from '../form/text-field.tsx';
import { Dialog } from './dialog.tsx';

/**
 * Confirmation levels of a row or bulk action (super list rules). Level 1 (safe: open, copy, print,
 * preview, export) has no dialog, so it is not a value here: run the action at once.
 * 2: reversible but affects others (deactivate, suspend, reject, hide, pause, change role): a dialog
 *    naming the row and the consequence; reject and suspend also need a reason.
 * 3: irreversible, or money or security (delete, merge, refund, cancel order, approve wallet
 *    credit, reset two-step): the dialog, and the person types the row's name or id to confirm.
 *    Money and security actions also ask for a step-up code; the server decides that and the
 *    caller repeats the request through the panel's guarded call (`useGuardedCall`), so
 *    `onConfirm` just returns the failure message; `stepUp` only adds a line telling the person.
 */
export type ConfirmLevel = 2 | 3;

export interface ConfirmActionProps {
  readonly open: boolean;
  readonly level: ConfirmLevel;
  /** Names the row: "Deactivate Ada Admin?". */
  readonly title: string;
  /** The consequence, in words. */
  readonly body: ReactNode;
  /** Level 3: the text the person types (the row's name or id). */
  readonly rowName: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** Asks for a reason before the action (reject, suspend); `required` keeps Confirm off until given. */
  readonly reason?: {
    readonly label: string;
    readonly help?: string;
    readonly required: boolean;
    readonly maxLength?: number;
  };
  /** Level 3 prompt, e.g. "Type the name to confirm"; the typed text must equal `rowName`. */
  readonly typeLabel?: string;
  /** A line under the body for a money or security action: a code will be asked next. */
  readonly stepUpNote?: string;
  readonly pending: boolean;
  /** The failure of the last try, shown in the dialog. */
  readonly error?: string | null;
  readonly onConfirm: (reason: string) => void;
  readonly onCancel: () => void;
}

/** The confirmation dialog of an action: red Confirm, focus on Cancel, typed confirmation at level 3. */
export function ConfirmAction({
  open,
  level,
  title,
  body,
  rowName,
  confirmLabel,
  cancelLabel,
  reason,
  typeLabel,
  stepUpNote,
  pending,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmActionProps) {
  const [typed, setTyped] = useState('');
  const [why, setWhy] = useState('');
  const cancel = useRef<HTMLButtonElement>(null);
  // Closed (done or cancelled): the next opening starts empty.
  useEffect(() => {
    if (!open) {
      setTyped('');
      setWhy('');
    }
  }, [open]);

  // Level 3 fails closed: with no row name to type there is nothing to confirm against.
  const typedOk = level === 2 || (rowName.trim() !== '' && typed.trim() === rowName.trim());
  const reasonOk = reason === undefined || !reason.required || why.trim().length > 0;
  const ready = typedOk && reasonOk && !pending;
  const close = () => {
    if (pending) return;
    setTyped('');
    setWhy('');
    onCancel();
  };

  return (
    <Dialog
      open={open}
      title={title}
      onClose={close}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" onClick={close} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant="destructive-solid"
            loading={pending}
            disabled={!ready && !pending}
            onClick={() => {
              if (ready) onConfirm(why.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>{body}</div>
        {stepUpNote === undefined ? null : <p className="text-sm text-fg-muted">{stepUpNote}</p>}
        {reason === undefined ? null : (
          <TextAreaField
            label={reason.label}
            help={reason.help}
            rows={3}
            maxLength={reason.maxLength ?? 500}
            value={why}
            onChange={(event) => setWhy(event.target.value)}
            disabled={pending}
          />
        )}
        {level === 3 ? (
          <TextField
            label={typeLabel ?? rowName}
            help={<span className="font-medium text-fg">{rowName}</span>}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            disabled={pending}
          />
        ) : null}
        {error === null ? null : <Banner tone="critical">{error}</Banner>}
      </div>
    </Dialog>
  );
}
