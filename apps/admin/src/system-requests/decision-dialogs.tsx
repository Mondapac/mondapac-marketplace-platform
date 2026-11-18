'use client';

import { BottomSheet, Button, Dialog, TextAreaField, toast, useDesktop } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { isFieldFailure, notifyChanged, refusalOf, type Refusal } from './errors.ts';
import { BASE, NOTE_MAX, isApproval, type SystemRequest } from './types.ts';

export type Decide = 'approve' | 'reject' | 'withdraw';

/** The dialog on a desktop, the bottom sheet on a phone; the buttons come with the content. */
function Frame({
  title,
  onClose,
  actions,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  const desktop = useDesktop();
  const t = useTranslations('system-requests');
  if (desktop) {
    return (
      <Dialog open title={title} onClose={onClose} actions={actions}>
        {children}
      </Dialog>
    );
  }
  return (
    <BottomSheet open title={title} closeLabel={t('close')} onClose={onClose}>
      <div className="flex flex-col gap-4 text-fg-secondary">
        {children}
        <div className="flex flex-col-reverse gap-3">{actions}</div>
      </div>
    </BottomSheet>
  );
}

/**
 * The confirm dialog of one decision on one request: Approve (no field), Reject and Withdraw (a
 * reason of 1 to 500 characters). A high-risk decision asks for a two-step code after the button
 * (the shared step-up dialog); cancelling that code closes this dialog and leaves the request
 * open. A refusal closes the dialog and goes to the page as a banner; a success says so in a
 * toast. Renders nothing while `kind` is null.
 */
export function DecisionDialog({
  kind,
  request,
  csrfToken,
  initialReason = '',
  onClose,
  onDecided,
  onRefused,
}: {
  readonly kind: Decide | null;
  readonly request: SystemRequest | null;
  readonly csrfToken: string;
  /** The reason typed before a refusal that can be repeated, so Try again does not lose it. */
  readonly initialReason?: string;
  readonly onClose: () => void;
  /** The decision went through: the request as the API now has it. */
  readonly onDecided: (kind: Decide, request: SystemRequest) => void;
  readonly onRefused: (refusal: Refusal, kind: Decide, reason: string) => void;
}) {
  if (kind === null || request === null) return null;
  return (
    <DecisionBody
      key={`${kind}:${request.id}`}
      kind={kind}
      request={request}
      csrfToken={csrfToken}
      initialReason={initialReason}
      onClose={onClose}
      onDecided={onDecided}
      onRefused={onRefused}
    />
  );
}

function DecisionBody({
  kind,
  request,
  csrfToken,
  initialReason,
  onClose,
  onDecided,
  onRefused,
}: {
  readonly kind: Decide;
  readonly request: SystemRequest;
  readonly csrfToken: string;
  readonly initialReason: string;
  readonly onClose: () => void;
  readonly onDecided: (kind: Decide, request: SystemRequest) => void;
  readonly onRefused: (refusal: Refusal, kind: Decide, reason: string) => void;
}) {
  const t = useTranslations('system-requests.decide');
  const guarded = useGuardedCall();
  const [reason, setReason] = useState(initialReason);
  const [problem, setProblem] = useState<'required' | 'rejected' | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const needsReason = kind !== 'approve';
  const number = request.displayNumber;
  // An action that waits for approval has its own words: approving applies it, declining changes nothing.
  const group = isApproval(request) ? `approval.${kind}` : kind;

  async function confirm() {
    if (inFlight.current) return;
    const text = reason.trim();
    if (needsReason && text === '') {
      setProblem('required');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const result = await guarded<SystemRequest>(
      'POST',
      `${BASE}/requests/${request.id}/${kind}`,
      needsReason ? { reason: text } : undefined,
      csrfToken,
    );
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      toast.success(t(`toast.${isApproval(request) ? `approval-${kind}` : kind}`, { number }));
      notifyChanged();
      onDecided(kind, result.body);
      return;
    }
    // The code dialog was closed: the request stays open and nothing is said.
    if (isStepUpCancelled(result)) {
      onClose();
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (needsReason && isFieldFailure(failure, 'reason')) {
      setProblem('rejected');
      return;
    }
    onRefused(refusalOf(failure), kind, text);
  }

  const cancel = (
    <Button
      key="cancel"
      variant="secondary"
      autoFocus={!needsReason}
      disabled={busy}
      onClick={onClose}
    >
      {t('cancel')}
    </Button>
  );
  const confirmButton = (
    <Button
      key="confirm"
      variant={kind === 'approve' ? 'primary' : 'destructive-solid'}
      loading={busy}
      onClick={() => void confirm()}
    >
      {t(`${group}.confirm`)}
    </Button>
  );

  return (
    <Frame
      title={t(`${group}.title`, { number })}
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <>
          {cancel}
          {confirmButton}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p>{t(`${group}.body`)}</p>
        {kind === 'approve' && request.risk === 'high' ? (
          <p className="font-medium text-attention-fg">{t('approve.high-risk')}</p>
        ) : null}
        {needsReason ? (
          <>
            {request.risk === 'high' ? (
              <p className="font-medium text-attention-fg">{t('step-up-note')}</p>
            ) : null}
            <TextAreaField
              name="reason"
              label={t(`${group}.reason`)}
              rows={3}
              maxLength={NOTE_MAX}
              autoFocus
              value={reason}
              readOnly={busy}
              counter={t('counter', { count: reason.length, max: NOTE_MAX })}
              error={problem === null ? undefined : t(`error.${problem}`)}
              onChange={(event) => {
                setReason(event.target.value);
                setProblem(null);
              }}
            />
          </>
        ) : null}
      </div>
    </Frame>
  );
}
