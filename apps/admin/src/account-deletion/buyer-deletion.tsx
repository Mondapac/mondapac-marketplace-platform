'use client';

import { ActionRow, Badge, Banner, Button, CheckboxRow, TextField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { formatInstant } from '../shared/format.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { CancelDeletionDialog, type CancelOutcome } from './cancel-dialog.tsx';
import { blockersOf, deletionProblemOf } from './errors.ts';
import { ReasonDialog } from './reason-dialog.tsx';
import {
  reasonProblem,
  REQUESTS_HREF,
  TICKET_PATTERN,
  type AdminDeletionRequestMade,
  type Blocker,
} from './types.ts';

type Notice =
  | { readonly kind: 'requested'; readonly date: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'blocked'; readonly blockers: readonly Blocker[] }
  | { readonly kind: 'error'; readonly problem: string };

/**
 * "Delete this buyer's account" on the customer lookup card (customers package 5c). The API has
 * no preflight route, so blockers show only after the attempt (409). Only the id of a request made
 * here is known; after a reload the card has no state, and a repeat request answers "already
 * requested" with a pointer to the pending list.
 */
export function BuyerDeletion({
  accountId,
  waitingPeriodDays,
  csrfToken,
}: {
  readonly accountId: string;
  /** The Market's waiting period, when the admin may read the setting; else null (no number). */
  readonly waitingPeriodDays: number | null;
  readonly csrfToken: string;
}) {
  const t = useTranslations('account-deletion');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState('');
  const [reason, setReason] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [ticketError, setTicketError] = useState(false);
  const [reasonError, setReasonError] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const busy = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  function openDialog() {
    setNotice(null);
    setTicket('');
    setReason('');
    setUnderstood(false);
    setTicketError(false);
    setReasonError(false);
    setOpen(true);
  }

  async function submit() {
    if (busy.current) return;
    const ref = ticket.trim();
    const badTicket = !TICKET_PATTERN.test(ref);
    const badReason = reasonProblem(reason);
    setTicketError(badTicket);
    setReasonError(badReason);
    if (badTicket || badReason || !understood) return;
    busy.current = true;
    setPending(true);
    setNotice(null);
    // The confirm closes first, so the code dialog never opens on top of it.
    setOpen(false);
    const result = await guarded<AdminDeletionRequestMade>(
      'POST',
      `customers/admin/buyers/${encodeURIComponent(accountId)}/deletion-requests`,
      { ticketRef: ref, reason: reason.trim(), confirm: true },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setRequestId(result.body.requestId);
      setNotice({ kind: 'requested', date: formatInstant(result.body.scheduledFor, locale) });
      setTicket('');
      setReason('');
      setUnderstood(false);
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const problem = deletionProblemOf(result.failure);
    if (problem === 'blocked') {
      setNotice({ kind: 'blocked', blockers: blockersOf(result.failure) });
    } else setNotice({ kind: 'error', problem });
  }

  function cancelled(id: string, outcome: CancelOutcome) {
    if (outcome.kind === 'cancelled') {
      setRequestId(null);
      setNotice({ kind: 'cancelled' });
      return;
    }
    // A request that is gone is no longer ours to cancel; one in progress cannot be.
    if (outcome.problem === 'request-not-found' || outcome.problem === 'in-progress') {
      if (id === requestId) setRequestId(null);
    }
    setNotice({ kind: 'error', problem: outcome.problem });
  }

  const blockerLine = (blocker: Blocker): string | null => {
    switch (blocker.code) {
      case 'open-orders':
        return t('buyer.blocker.open-orders', { count: blocker.count ?? 0 });
      case 'pending-refunds':
        return t('buyer.blocker.pending-refunds', { count: blocker.count ?? 0 });
      case 'wallet-balance':
        return t('buyer.blocker.wallet-balance');
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {notice === null ? null : (
        <div ref={noticeRef} tabIndex={-1}>
          {notice.kind === 'requested' ? (
            <Banner tone="success">{t('buyer.requested', { date: notice.date })}</Banner>
          ) : notice.kind === 'cancelled' ? (
            <Banner tone="success">{t('buyer.cancelled')}</Banner>
          ) : notice.kind === 'blocked' ? (
            <Banner tone="critical" title={t('buyer.blocked-title')}>
              <ul className="mt-1 list-disc ps-5">
                {notice.blockers.flatMap((blocker) => {
                  const line = blockerLine(blocker);
                  return line === null ? [] : [<li key={blocker.code}>{line}</li>];
                })}
              </ul>
            </Banner>
          ) : (
            <Banner tone="critical">
              {t(`error.${notice.problem}`)}
              {notice.problem === 'already-requested' ? (
                <>
                  {' '}
                  <a className="font-medium underline" href={REQUESTS_HREF}>
                    {t('buyer.open-pending')}
                  </a>
                </>
              ) : null}
            </Banner>
          )}
        </div>
      )}
      {requestId === null ? (
        <ActionRow>
          <Button variant="destructive" disabled={pending} onClick={openDialog}>
            {t('buyer.action')}
          </Button>
        </ActionRow>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="attention">{t('buyer.pending-badge')}</Badge>
          <Button variant="secondary" onClick={() => setCancelling(requestId)}>
            {t('requests.cancel')}
          </Button>
        </div>
      )}
      <ReasonDialog
        open={open}
        title={t('buyer.dialog.title')}
        before={
          <TextField
            name="ticketRef"
            data-first=""
            label={t('buyer.ticket.label')}
            help={t('buyer.ticket.help')}
            autoComplete="off"
            spellCheck={false}
            maxLength={80}
            value={ticket}
            error={ticketError ? t('buyer.ticket.error') : undefined}
            onChange={(event) => {
              setTicket(event.target.value);
              setTicketError(false);
            }}
          />
        }
        after={
          <CheckboxRow
            name="understood"
            label={
              waitingPeriodDays === null
                ? t('buyer.understand-unknown')
                : t('buyer.understand', { days: waitingPeriodDays })
            }
            checked={understood}
            onChange={(event) => setUnderstood(event.target.checked)}
          />
        }
        reasonLabel={t('reason.label')}
        reasonHelp={t('reason.help-deleted')}
        reason={reason}
        reasonError={reasonError ? t('error.invalid') : undefined}
        onReasonChange={(value) => {
          setReason(value);
          setReasonError(false);
        }}
        confirmLabel={t('buyer.dialog.confirm')}
        cancelLabel={t('cancel')}
        destructive
        pending={pending}
        canConfirm={understood}
        onConfirm={() => void submit()}
        onCancel={() => setOpen(false)}
      >
        <p>
          {waitingPeriodDays === null
            ? t('buyer.dialog.date-unknown')
            : t('buyer.dialog.date', { days: waitingPeriodDays })}
        </p>
      </ReasonDialog>
      <CancelDeletionDialog
        requestId={cancelling}
        csrfToken={csrfToken}
        onClose={() => setCancelling(null)}
        onDone={cancelled}
      />
    </div>
  );
}
