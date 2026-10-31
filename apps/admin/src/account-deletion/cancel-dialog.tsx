'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { deletionProblemOf } from './errors.ts';
import { ReasonDialog } from './reason-dialog.tsx';
import { reasonProblem } from './types.ts';

/** What the dialog tells its screen when it closes after a call. */
export type CancelOutcome =
  { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly problem: string };

/**
 * "Cancel this deletion request?": a reason (checked, never stored by the API) and the two-step
 * code, then `DELETE customers/admin/deletion-requests/:id`. Shared by the pending list and the
 * buyer card. The screen decides what each outcome does to its rows; a cancelled code is silent.
 */
export function CancelDeletionDialog({
  requestId,
  csrfToken,
  onClose,
  onDone,
}: {
  /** The request to cancel; null keeps the dialog closed. */
  readonly requestId: string | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (requestId: string, outcome: CancelOutcome) => void;
}) {
  const t = useTranslations('account-deletion');
  const guarded = useGuardedCall();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  // A new row, or a close, starts clean: a reason typed for one request is never reused.
  useEffect(() => {
    setReason('');
    setReasonError(false);
  }, [requestId]);

  async function confirm() {
    if (busy.current || requestId === null) return;
    if (reasonProblem(reason)) {
      setReasonError(true);
      return;
    }
    busy.current = true;
    setPending(true);
    const id = requestId;
    // The confirm closes first, so the code dialog never opens on top of it.
    onClose();
    const result = await guarded<unknown>(
      'DELETE',
      `customers/admin/deletion-requests/${encodeURIComponent(id)}`,
      { reason: reason.trim() },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setReason('');
      onDone(id, { kind: 'cancelled' });
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    onDone(id, { kind: 'failed', problem: deletionProblemOf(result.failure) });
  }

  return (
    <ReasonDialog
      open={requestId !== null}
      title={t('cancel-request.title')}
      reasonLabel={t('reason.label')}
      reasonHelp={t('reason.help-not-stored')}
      reason={reason}
      reasonError={reasonError ? t('error.invalid') : undefined}
      onReasonChange={(value) => {
        setReason(value);
        setReasonError(false);
      }}
      confirmLabel={t('cancel-request.confirm')}
      cancelLabel={t('cancel-request.keep')}
      destructive
      pending={pending}
      onConfirm={() => void confirm()}
      onCancel={() => {
        setReasonError(false);
        onClose();
      }}
    >
      <p>{t('cancel-request.body')}</p>
    </ReasonDialog>
  );
}
