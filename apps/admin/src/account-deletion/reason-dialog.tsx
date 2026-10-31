'use client';

import { Button, Dialog, TextAreaField } from '@mondapac/ui';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * The one confirm dialog of the account deletion screens (settings change, cancel a request,
 * delete a buyer's account): a body, optional extra fields, a required Reason and two buttons.
 * It is a form, so Enter in a single-line field goes through the same check as the button; Enter
 * in the Reason is ignored (the reason is one line, and Enter never confirms from there).
 * Focus goes to the first field when it opens (the element marked `data-first`, else the Reason),
 * never to the primary button; closing returns focus to the opener (the native dialog).
 */
export function ReasonDialog({
  open,
  title,
  children,
  before,
  after,
  reasonLabel,
  reasonHelp,
  reason,
  reasonError,
  onReasonChange,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending,
  canConfirm = true,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  /** The body text under the title. */
  readonly children?: ReactNode;
  /** Fields above the Reason (the support ticket). */
  readonly before?: ReactNode;
  /** Fields below the Reason (an acknowledgement). */
  readonly after?: ReactNode;
  readonly reasonLabel: string;
  readonly reasonHelp: string;
  readonly reason: string;
  readonly reasonError?: string | undefined;
  readonly onReasonChange: (value: string) => void;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly destructive?: boolean;
  readonly pending: boolean;
  /** False keeps the confirm button off (an unticked acknowledgement). */
  readonly canConfirm?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const formId = useId();
  const body = useRef<HTMLDivElement>(null);

  // After the layout effect that opens the native dialog, so the field is focusable.
  useEffect(() => {
    if (!open) return;
    const field =
      body.current?.querySelector<HTMLElement>('[data-first]') ??
      body.current?.querySelector<HTMLElement>('textarea');
    field?.focus();
  }, [open]);

  return (
    <Dialog
      open={open}
      title={title}
      onClose={() => {
        if (!pending) onCancel();
      }}
      actions={
        <>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            loading={pending}
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div ref={body} className="flex flex-col gap-4">
        {children}
        <form
          id={formId}
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (canConfirm && !pending) onConfirm();
          }}
        >
          {before}
          <TextAreaField
            name="reason"
            label={reasonLabel}
            help={reasonHelp}
            rows={2}
            maxLength={600}
            value={reason}
            error={reasonError}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
            onChange={(event) => onReasonChange(event.target.value)}
          />
          {after}
        </form>
      </div>
    </Dialog>
  );
}
