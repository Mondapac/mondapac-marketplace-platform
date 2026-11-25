'use client';

import { Banner, Button, Dialog, TextAreaField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';

/** The reason the API takes for a flag change: 1 to 500 characters once trimmed. */
export const REASON_MAX = 500;

export type ReasonResult =
  | { readonly kind: 'done' }
  /** The two-step code dialog was closed: stay as it was, say nothing. */
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

const lengthOf = (text: string): number => [...text.trim()].length;

/**
 * The question behind every Offer review flag change: a reason of 1 to 500 characters (always
 * required, kept in the change log for admins), then Confirm. The caller sends the change (with
 * its two-step code when the flag is protected) and says how it went; a refusal stays here, the
 * dialog closes only when the change was made.
 */
export function ReasonDialog({
  title,
  intro,
  confirm,
  confirmVariant = 'primary',
  onClose,
  onConfirm,
}: {
  readonly title: string;
  readonly intro: ReactNode;
  readonly confirm: string;
  readonly confirmVariant?: 'primary' | 'destructive-solid';
  readonly onClose: () => void;
  readonly onConfirm: (reason: string) => Promise<ReasonResult>;
}) {
  const t = useTranslations('offer-review.reason-dialog');
  const busy = useRef(false);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const length = lengthOf(reason);
  const valid = length >= 1 && length <= REASON_MAX;

  async function submit() {
    if (busy.current || !valid) {
      setTouched(true);
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await onConfirm(reason.trim());
    busy.current = false;
    setPending(false);
    if (result.kind === 'failed') setProblem(result.message);
    if (result.kind === 'done') onClose();
  }

  return (
    <Dialog
      open
      size="form"
      title={title}
      onClose={() => {
        if (!pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant={confirmVariant}
            loading={pending}
            disabled={pending}
            onClick={() => void submit()}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-sm">{intro}</div>
        {problem === null ? null : (
          <div role="alert">
            <Banner tone="critical">{problem}</Banner>
          </div>
        )}
        <TextAreaField
          name="reason"
          label={t('reason')}
          help={t('reason-help')}
          rows={3}
          value={reason}
          disabled={pending}
          error={
            length > REASON_MAX
              ? t('too-long', { max: REASON_MAX })
              : touched && length === 0
                ? t('required')
                : undefined
          }
          counter={t('counter', { count: length, max: REASON_MAX })}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
    </Dialog>
  );
}
